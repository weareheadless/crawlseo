/**
 * Does a page answer a specific need? (execution brief §3)
 *
 * The product used to decide this from a URL sample: a finding said "the site has
 * no foreign-ownership content", nothing looked at the page that discusses
 * fideicomiso, and the claim was published. Titles and paths cannot settle a
 * semantic question, and a crawl that only sampled 30 URLs cannot prove absence.
 *
 * This module assesses stored page text against a need. It is lexical and
 * deterministic on purpose: the same page and need always produce the same
 * assessment, the matched terms are shown, and the method is declared so nobody
 * mistakes it for a semantic audit. A page with no retrievable text is
 * `unassessable`, never "does not answer".
 */

import type { CoverageAssessment, CoverageState } from "@/lib/funnel/decision";

export type CoveragePage = {
  url: string;
  title: string | null;
  /** Extracted body text, or null when it was not retrieved. */
  contentText: string | null;
  /** Why the text is missing, when it is. */
  unavailableReason?: string | null;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "without", "from", "this", "that", "these", "those",
  "our", "your", "their", "its", "are", "was", "were", "have", "has", "had", "will",
  "would", "can", "could", "should", "not", "but", "they", "them", "there", "what",
  "when", "where", "which", "who", "how", "why", "all", "any", "some", "more", "most",
  "les", "des", "une", "aux", "pour", "avec", "sans", "dans", "sur", "est", "sont",
  "que", "qui", "pas", "plus", "mais", "leur", "leurs", "cette", "ces", "son", "sa",
  "los", "las", "una", "unos", "unas", "para", "con", "sin", "por", "como", "que",
  "del", "más", "pero", "sus", "este", "esta", "estos", "estas",
]);

/** Lower-case, accent-free words of at least three letters. */
export function contentTerms(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/** Crude singular so "closing costs" matches "closing cost". */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export function needTerms(statement: string, extra: string[] = []): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of [...contentTerms(statement), ...extra.flatMap((value) => contentTerms(value))]) {
    const key = stem(token);
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(key);
  }
  return terms;
}

export type CoverageThresholds = {
  /** Share of the need's terms a page must contain to count as answering. */
  answers: number;
  /** Share that makes it a partial answer. */
  partial: number;
  /** Below this the page is not topically related and is not reported. */
  relevant: number;
  /** Minimum matched terms, so one common word cannot carry a page. */
  minMatched: number;
};

export const DEFAULT_COVERAGE_THRESHOLDS: CoverageThresholds = {
  answers: 0.6,
  partial: 0.3,
  relevant: 0.2,
  minMatched: 2,
};

function excerptAround(text: string, term: string): string {
  const index = text.toLowerCase().indexOf(term);
  if (index < 0) return "";
  const start = Math.max(0, index - 110);
  const end = Math.min(text.length, index + 190);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Assess every page that is topically related to the need.
 *
 * Returns the best matches first, at most `limit`. A page with no text is reported
 * as `unassessable` only when its title is related, so a blocked page that has
 * nothing to do with the need does not clutter the result.
 */
export function assessCoverage(
  need: { statement: string; audience?: string | null; extraTerms?: string[] },
  pages: CoveragePage[],
  thresholds: CoverageThresholds = DEFAULT_COVERAGE_THRESHOLDS,
  limit = 5
): CoverageAssessment[] {
  const terms = needTerms(need.statement, [need.audience ?? "", ...(need.extraTerms ?? [])]);
  if (terms.length === 0) return [];

  const scored: Array<{ assessment: CoverageAssessment; ratio: number }> = [];
  for (const page of pages) {
    const title = page.title ?? "";
    const text = page.contentText ?? "";
    const haystack = `${title}\n${text}`
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    const haystackTerms = new Set(contentTerms(haystack).map(stem));
    const matched = terms.filter((term) => haystackTerms.has(term));
    const ratio = matched.length / terms.length;

    if (!page.contentText) {
      // The URL is part of the evidence that this page is about the subject: a
      // blocked page at /category/abat-jours is relevant even when its title is an
      // anti-bot challenge.
      const titleTerms = new Set(contentTerms(`${title} ${page.url}`).map(stem));
      const titleMatched = terms.filter((term) => titleTerms.has(term));
      if (titleMatched.length < Math.max(1, thresholds.minMatched)) continue;
      scored.push({
        ratio: titleMatched.length / terms.length,
        assessment: {
          pageUrl: page.url,
          state: "unassessable",
          method: "lexical",
          matchedTerms: titleMatched,
          excerpts: [],
          note: page.unavailableReason
            ? `page text unavailable: ${page.unavailableReason}`
            : "page text was not retrieved, so coverage cannot be judged",
        },
      });
      continue;
    }

    if (matched.length < thresholds.minMatched || ratio < thresholds.relevant) continue;
    const state: CoverageState =
      ratio >= thresholds.answers ? "answers" : ratio >= thresholds.partial ? "partially_answers" : "does_not_answer";
    scored.push({
      ratio,
      assessment: {
        pageUrl: page.url,
        state,
        method: "lexical",
        matchedTerms: matched,
        excerpts: matched.slice(0, 2).map((term) => excerptAround(text, term)).filter(Boolean),
        note: `${matched.length} of ${terms.length} need terms present (${Math.round(ratio * 100)}%)`,
      },
    });
  }

  return scored
    .sort((a, b) => b.ratio - a.ratio || a.assessment.pageUrl.localeCompare(b.assessment.pageUrl))
    .slice(0, limit)
    .map((row) => row.assessment);
}

/** The strongest state found, for a one-line summary. */
export function coverageSummary(assessments: CoverageAssessment[]): CoverageState | "not_assessed" {
  if (assessments.length === 0) return "not_assessed";
  if (assessments.some((row) => row.state === "answers")) return "answers";
  if (assessments.some((row) => row.state === "partially_answers")) return "partially_answers";
  if (assessments.some((row) => row.state === "unassessable")) return "unassessable";
  return "does_not_answer";
}
