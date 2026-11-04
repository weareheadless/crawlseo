import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import { assessFinding, type AssessmentRunDb } from "@/lib/recommendation/run";
import type { RecommendationDecision } from "@/lib/recommendation/contracts";
import type { assessRecommendation } from "@/lib/recommendation/assess";
import type { AnalysisLedger } from "@/lib/recommendation/ledger";

/**
 * Bridge: business research findings → funnel evidence.
 *
 * The spine keeps `ResearchRun`/`ResearchFinding` as its run and finding models
 * (plan §4), but the funnel only reasons from evidence. Without this bridge the
 * business-research lane never reaches the opportunity board, which is the whole
 * point of the "why" leg.
 *
 * Additive by design: it writes `research_finding` evidence and touches nothing
 * else. That is what makes it safe to run alongside the legacy pipeline while
 * that pipeline is still the producer.
 */

export type FindingBridgeDb = Pick<PrismaClient, "researchFinding" | "evidenceRecord"> &
  Parameters<typeof storeEvidenceRecord>[0] &
  AssessmentRunDb;

type StoredFinding = {
  id: string;
  runId: string;
  type: string;
  theme: string;
  primaryQuery?: string | null;
  summary: string;
  confidence: number;
  sentiment: string | null;
  urgency: string | null;
  verification?: unknown;
  evidenceSourceIds?: unknown;
  createdAt: Date;
};

/**
 * A finding becomes an opportunity input only when it names a winnable gap.
 * Everything else stays context: the taxonomy's O13/O14 detectors look for
 * `painPoint` and `positioningGap`, so those flags are set from the finding
 * type rather than guessed from prose.
 */
// The research runner emits the enum's types, not the detector's original
// vocabulary. These sets accept both, so a CONCERN is a pain point and a
// POSITIONING_GAP is a positioning gap without a second finding pipeline.
const PAIN_POINT_TYPES = new Set([
  "PAIN_POINT", "CUSTOMER_NEED", "FRICTION", "OBJECTION", "CONCERN", "MISCONCEPTION", "QUESTION", "CONTENT_GAP",
]);
const POSITIONING_TYPES = new Set([
  "COMPETITOR", "POSITIONING", "MARKET_GAP", "OPPORTUNITY", "POSITIONING_GAP", "COMPETITOR_GAP",
]);

/**
 * The label an opportunity carries on the board.
 *
 * A finding has three parts and they are not interchangeable: `theme` is the
 * label, `primaryQuery` is the keyword the join validates, `summary` is the prose
 * that justifies the finding. The detectors used to put the summary in the title,
 * which produced 150-character paragraphs where a label belonged, while the theme
 * sat unused in the same row.
 */
function findingTitle(finding: StoredFinding): string {
  const theme = finding.theme?.trim();
  if (theme) return theme.slice(0, 120);
  const query = finding.primaryQuery?.trim();
  if (query) return query.slice(0, 120);
  return finding.summary.trim().slice(0, 120);
}

export function findingDimensions(finding: StoredFinding): Record<string, string | number | boolean | null> {
  const isPainPoint = PAIN_POINT_TYPES.has(finding.type);
  const isPositioning = POSITIONING_TYPES.has(finding.type);
  return {
    findingId: finding.id,
    runId: finding.runId,
    findingType: finding.type,
    theme: finding.theme,
    title: findingTitle(finding),
    // The phrase to validate; the join runner collects on this, not on the theme.
    query: finding.primaryQuery ?? null,
    // The detectors read these two flags; a finding without a winnable gap
    // stays context and never becomes a task.
    painPoint: isPainPoint ? "true" : null,
    painPointSummary: isPainPoint ? finding.summary : null,
    positioningGap: isPositioning ? "true" : null,
    gapSummary: isPositioning ? finding.summary : null,
    urgency: finding.urgency,
    sentiment: finding.sentiment,
    // The claim's verification travels with the evidence. Without it a
    // contradicted premise becomes an opportunity again the moment it is bridged.
    verification: verificationStatus(finding.verification),
    verificationReason: verificationReason(finding.verification),
    coverageState: coverageField(finding.verification, "state"),
    coveragePage: coverageField(finding.verification, "pageUrl"),
    coverageComplete: coverageCompleteField(finding.verification),
  };
}

/** The strongest coverage state recorded with the verification, if any. */
function coverageField(value: unknown, key: "state" | "pageUrl"): string | null {
  const coverage = (value as { coverage?: unknown } | null)?.coverage;
  if (!Array.isArray(coverage) || coverage.length === 0) return null;
  const ranked = [...coverage] as Array<{ state?: string; pageUrl?: string }>;
  const order = ["answers", "partially_answers", "unassessable", "does_not_answer"];
  ranked.sort((a, b) => order.indexOf(a.state ?? "") - order.indexOf(b.state ?? ""));
  const entry = ranked[0];
  const field = key === "state" ? entry.state : entry.pageUrl;
  return typeof field === "string" ? field : null;
}

function coverageCompleteField(value: unknown): string | null {
  const complete = (value as { coverageComplete?: unknown } | null)?.coverageComplete;
  return typeof complete === "boolean" ? (complete ? "true" : "false") : null;
}

function verificationStatus(value: unknown): string | null {
  const status = (value as { status?: unknown } | null)?.status;
  return typeof status === "string" ? status : null;
}

function verificationReason(value: unknown): string | null {
  const reason = (value as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? reason : null;
}

export type FindingBridgeResult = {
  findings: number;
  stored: number;
  /** Findings that carry a winnable gap and can therefore reach the board. */
  actionable: number;
  /** Findings assessed or reused from a matching sealed packet. */
  assessed: number;
  /** Findings whose assessment could not be made, with the reason. */
  assessmentFailures: Array<{ theme: string; reason: string }>;
};

function bridgeDedupKey(finding: StoredFinding): string {
  const prefix = POSITIONING_TYPES.has(finding.type) ? "O14" : "O13";
  const tokens = findingTokenList(finding.theme).sort();
  return `${prefix}:${tokens.join(" ") || finding.id}`;
}

export async function bridgeFindingsToEvidence(
  db: FindingBridgeDb,
  opts: {
    projectId: string;
    siteId?: string | null;
    runId: string;
    /** The model-backed assessor; tests may inject a deterministic one. */
    assess?: typeof assessRecommendation;
    /** Bounded attempts, including failures. Reuse does not consume an attempt. */
    maxAssessments?: number;
    /** Shared across new findings and reassessment in one run. */
    ledger?: AnalysisLedger;
  }
): Promise<FindingBridgeResult> {
  const findings = (await db.researchFinding.findMany({
    where: { runId: opts.runId },
    select: {
      id: true,
      runId: true,
      type: true,
      theme: true,
      primaryQuery: true,
      summary: true,
      confidence: true,
      sentiment: true,
      urgency: true,
      verification: true,
      evidenceSourceIds: true,
      createdAt: true,
    },
  })) as StoredFinding[];

  const maxAssessments = Math.max(0, Math.min(opts.maxAssessments ?? 6, 12));
  let stored = 0;
  let actionable = 0;
  let assessed = 0;
  let attempted = 0;
  const assessmentFailures: Array<{ theme: string; reason: string }> = [];

  for (const finding of findings) {
    const dimensions = findingDimensions(finding);
    if (dimensions.painPoint === "true" || dimensions.positioningGap === "true") actionable += 1;
    const eligible = dimensions.painPoint === "true" || dimensions.positioningGap === "true";

    if (!eligible || !opts.siteId) {
      // Context-only findings are evidence, not work. They carry no decision.
      await storeEvidenceRecord(db, {
        projectId: opts.projectId,
        siteId: opts.siteId ?? null,
        kind: "research_finding",
        observedAt: finding.createdAt,
        producer: "research-runner",
        dimensions,
        metrics: {
          "first_party:confidence": { value: finding.confidence, unit: "score", source: "first_party" },
        },
      });
      stored += 1;
      continue;
    }

    if (attempted >= maxAssessments) {
      await storeEvidenceRecord(db, {
        projectId: opts.projectId,
        siteId: opts.siteId,
        kind: "research_finding",
        observedAt: finding.createdAt,
        producer: "research-runner",
        dimensions: { ...dimensions, recommendationOutcome: "not_assessed_budget" },
        metrics: {
          "first_party:confidence": { value: finding.confidence, unit: "score", source: "first_party" },
        },
      });
      assessmentFailures.push({ theme: finding.theme, reason: "assessment budget exhausted" });
      stored += 1;
      continue;
    }

    attempted += 1;
    const sourceIds = Array.isArray(finding.evidenceSourceIds)
      ? finding.evidenceSourceIds.filter((value): value is string => typeof value === "string")
      : [];
    const result = await assessFinding(db, {
      projectId: opts.projectId,
      siteId: opts.siteId,
      assessor: opts.assess,
      ledger: opts.ledger,
      finding: {
        id: finding.id,
        runId: finding.runId,
        type: finding.type,
        theme: finding.theme,
        summary: String(dimensions.painPointSummary ?? dimensions.gapSummary ?? finding.summary),
        premise: String(dimensions.painPointSummary ?? dimensions.gapSummary ?? finding.summary),
        observedAt: finding.createdAt,
        sourceIds,
        dedupKey: bridgeDedupKey(finding),
        dimensions,
      },
    });

    stored += 1;
    if (result.status === "assessed" || result.status === "reused") assessed += 1;
    if (result.status === "failed") {
      assessmentFailures.push({
        theme: finding.theme,
        reason: result.errors.join("; ").slice(0, 400) || "assessment failed",
      });
    }
  }

  return { findings: findings.length, stored, actionable, assessed, assessmentFailures };
}

/**
 * Group findings that describe the same insight.
 *
 * Dedup used to key on the summary text, so a re-run that phrased the same insight
 * differently produced a second opportunity. One tenant's board carried three
 * sargassum risks and two Tulum-oversupply rows — five insights, ten rows.
 *
 * Grouping is on the theme's distinctive words, not its wording. Every member keeps
 * its evidence, so collapsing duplicates loses nothing, and the key is the set of
 * words the whole cluster shares, which is stable across re-phrasings.
 */
const FINDING_STOPWORDS = new Set([
  "the", "and", "for", "with", "without", "from", "this", "that", "into", "over",
  "les", "des", "une", "aux", "pour", "avec", "sans", "dans", "sur", "est", "sont",
  "risk", "risks", "gap", "gaps", "issue", "issues", "narrative",
]);

function findingTokenList(value: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const token of value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (token.length < 4 || FINDING_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    ordered.push(token);
  }
  return ordered;
}

function findingTokens(value: string): Set<string> {
  return new Set(findingTokenList(value));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The word a theme is about: "Sargassum and coastal property risk" → sargassum. */
function subjectOf(value: string): string | null {
  return findingTokenList(value)[0] ?? null;
}

export type FindingCluster<T> = {
  representative: T;
  members: T[];
  /** Stable identity: the words every member shares, sorted. */
  key: string;
  tokens: Set<string>;
};

export function clusterFindings<T extends {
  id: string;
  theme?: string | null;
  summary: string;
  confidence?: number | null;
  createdAt?: Date;
}>(rows: T[], threshold = 0.5): FindingCluster<T>[] {
  const ordered = [...rows].sort((a, b) => {
    const confidence = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confidence !== 0) return confidence;
    return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
  });

  const clusters: Array<FindingCluster<T> & { tokens: Set<string>; subject: string | null }> = [];
  for (const row of ordered) {
    const label = row.theme ?? row.summary;
    const themeTokens = findingTokens(label);
    const subject = subjectOf(label);
    // Two findings are the same insight when they are about the same subject
    // ("sargassum", "tulum") or overlap heavily. Wording alone is not identity:
    // three sargassum risks shared only that one word and stayed three rows.
    const match = clusters.find((cluster) =>
      (subject !== null && cluster.subject === subject) || jaccard(themeTokens, cluster.tokens) >= threshold
    );
    if (match) {
      match.members.push(row);
      match.tokens = new Set([...match.tokens].filter((token) => themeTokens.has(token)));
      continue;
    }
    clusters.push({ representative: row, members: [row], key: "", tokens: themeTokens, subject });
  }

  return clusters.map((cluster) => {
    const shared = [...cluster.tokens].sort();
    const fallback = [...findingTokens(cluster.representative.theme ?? cluster.representative.summary)].sort();
    return {
      representative: cluster.representative,
      members: cluster.members,
      tokens: cluster.tokens,
      key: (shared.length > 0 ? shared : fallback).join(" ") || cluster.representative.id,
    };
  });
}
