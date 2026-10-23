export type HealthIssue = {
  url: string;
  type: string;
  severity: string;
  details?: unknown;
};

export type IssuePriority = {
  type: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  affectedPages: number;
  affectedPct: number;
  occurrences: number;
  penalty: number;
  sampleUrl: string;
};

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

const SEVERITY_IMPACT: Record<string, number> = {
  CRITICAL: 20,
  WARNING: 6,
  INFO: 1,
};

/**
 * Per-issue-type weight. These are deliberately not raw issue counts: a site
 * with 200 missing-alt warnings is still a mostly healthy site, while a few
 * broken links are a real technical problem.
 */
const TYPE_IMPACT: Record<string, number> = {
  BROKEN_LINK: 1.3,
  MISSING_TITLE: 1.2,
  MIXED_CONTENT: 1.2,
  MISSING_ROBOTS: 1.0,
  MISSING_SITEMAP: 1.0,
  MISSING_H1: 0.9,
  MISSING_DESCRIPTION: 0.9,
  DUPLICATE_TITLE: 0.9,
  SLOW_PAGE: 0.9,
  MISSING_ALT: 0.7,
  LARGE_PAGE: 0.7,
  MISSING_CANONICAL: 0.6,
  REDIRECT: 0.6,
  MULTIPLE_H1: 0.5,
  DUPLICATE_DESCRIPTION: 0.5,
  MISSING_SCHEMA: 0.4,
};

const DEFAULT_TYPE_IMPACT = 0.8;
const EXCLUDED_DETAIL_KINDS = new Set(["crawl_summary", "content_score"]);

function isExcluded(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const kind = (details as { kind?: unknown }).kind;
  return typeof kind === "string" && EXCLUDED_DETAIL_KINDS.has(kind);
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function severityRank(value: string): number {
  return SEVERITY_RANK[value] ?? 3;
}

export function buildIssuePriorities(
  issues: HealthIssue[],
  pagesFound: number,
): IssuePriority[] {
  if (pagesFound <= 0 || issues.length === 0) return [];

  type Group = {
    type: string;
    severity: string;
    urls: Set<string>;
    occurrences: number;
    sampleUrl: string;
  };

  const groups = new Map<string, Group>();
  for (const issue of issues) {
    if (isExcluded(issue.details)) continue;
    const existing = groups.get(issue.type);
    if (existing) {
      existing.urls.add(issue.url);
      existing.occurrences += 1;
      if (severityRank(issue.severity) < severityRank(existing.severity)) {
        existing.severity = issue.severity;
      }
      if (!existing.sampleUrl) existing.sampleUrl = issue.url;
    } else {
      groups.set(issue.type, {
        type: issue.type,
        severity: issue.severity,
        urls: new Set([issue.url]),
        occurrences: 1,
        sampleUrl: issue.url,
      });
    }
  }

  return [...groups.values()]
    .map((group) => {
      const affectedPages = Math.min(group.urls.size, pagesFound);
      const prevalence = affectedPages / pagesFound;
      const severityImpact = SEVERITY_IMPACT[group.severity] ?? 1;
      const typeImpact = TYPE_IMPACT[group.type] ?? DEFAULT_TYPE_IMPACT;
      // Half the weight applies as soon as the issue exists; the other half
      // scales with how much of the site is affected.
      const penalty = severityImpact * typeImpact * (0.5 + 0.5 * prevalence);
      return {
        type: group.type,
        severity: (["CRITICAL", "WARNING", "INFO"].includes(group.severity)
          ? group.severity
          : "INFO") as IssuePriority["severity"],
        affectedPages,
        affectedPct: clampPct(prevalence * 100),
        occurrences: group.occurrences,
        penalty: Math.round(penalty * 10) / 10,
        sampleUrl: group.sampleUrl,
      };
    })
    .sort(
      (a, b) =>
        b.penalty - a.penalty ||
        severityRank(a.severity) - severityRank(b.severity) ||
        b.affectedPages - a.affectedPages ||
        a.type.localeCompare(b.type),
    );
}

/**
 * Page-normalized technical health score.
 *
 * Raw issue count is not used directly. Each issue type contributes once,
 * weighted by severity and the share of crawled pages it affects. This keeps
 * repeated warnings on a large site from collapsing the score to zero while
 * still surfacing critical problems.
 */
export function computeHealthScore(
  issues: HealthIssue[],
  pagesFound: number,
): number {
  if (pagesFound <= 0) return 0;
  const penalties = buildIssuePriorities(issues, pagesFound);
  const score = 100 - penalties.reduce((sum, item) => sum + item.penalty, 0);
  return Math.max(0, Math.min(100, Math.round(score)));
}
