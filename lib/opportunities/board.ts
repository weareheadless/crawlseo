import type { PrismaClient } from "@prisma/client";

import { ExecutionError, withExecutions, type ExecutionRecord } from "@/lib/opportunities/external-execution";

/**
 * The queries a page is actually seen for, from Search Console.
 *
 * ## Why this is read rather than derived
 *
 * A work brief that says "strengthen this page for its head terms" without naming them is
 * not actionable: the executor either guesses which terms matter or rebuilds the query set
 * from scratch. Both are waste. The queries are a *stored fact* — Search Console recorded
 * each one against this exact page — so reading them is arithmetic, not judgement.
 *
 * The first version of this brief returned `queries: []` for these rows, because it only
 * looked at structured fields on the opportunity itself and the producing detector had left
 * the queries in prose. That is the honest null for that source, but it was the wrong source:
 * the measurement existed all along, keyed by page.
 *
 * Anchoring on the page URL is what makes this safe. It is not inferring which query belongs
 * to which topic — that would be the semantic judgement this codebase forbids — it is asking
 * Search Console "which queries returned this URL", which is a fact it recorded. When the
 * page is a proposal with no URL yet there is nothing to read, and the brief says so.
 */

export type PageQuery = {
  query: string;
  impressions: number;
  clicks: number;
  /** Impression-weighted average position, or null when a query had no impressions. */
  position: number | null;
};

/** How many queries a brief carries. Ordered by impressions, so this is a head, not a cap. */
export const BRIEF_QUERY_LIMIT = 25;

/**
 * Read the queries a page earns impressions for.
 *
 * Weighted by impressions rather than a plain average: a query seen once at position 80 and
 * once at position 3 is not "position 41", and reporting it that way would make a winnable
 * term look hopeless.
 */
export async function readPageQueries(
  db: Pick<PrismaClient, "keyword">,
  siteId: string,
  pageUrl: string | null,
  options: { windowDays?: number; limit?: number } = {}
): Promise<{ queries: PageQuery[]; windowDays: number; totalQueries: number }> {
  const windowDays = options.windowDays ?? 28;
  const limit = options.limit ?? BRIEF_QUERY_LIMIT;
  if (!pageUrl) return { queries: [], windowDays, totalQueries: 0 };

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db.keyword.findMany({
    where: { siteId, page: pageUrl, date: { gte: since } },
    select: { query: true, clicks: true, impressions: true, position: true },
  });

  const byQuery = new Map<string, { clicks: number; impressions: number; weightedPosition: number }>();
  for (const row of rows) {
    const current = byQuery.get(row.query) ?? { clicks: 0, impressions: 0, weightedPosition: 0 };
    current.clicks += row.clicks;
    current.impressions += row.impressions;
    current.weightedPosition += row.position * row.impressions;
    byQuery.set(row.query, current);
  }

  const queries = [...byQuery.entries()]
    .map(([query, value]) => ({
      query,
      impressions: value.impressions,
      clicks: value.clicks,
      position: value.impressions > 0
        ? Math.round((value.weightedPosition / value.impressions) * 10) / 10
        : null,
    }))
    .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));

  return { queries: queries.slice(0, limit), windowDays, totalQueries: queries.length };
}

/**
 * The opportunity board for one project, as an external executor sees it.
 *
 * ## Why this does not reuse `listConnectorOpportunities`
 *
 * That function is correct for what it serves — the HelloAda runtime — but it sits behind
 * `requireConnectorSite`, which demands an *active* `ConnectorBinding` with a specific
 * executor. An MCP client is not that executor, and tying the board to one integration's
 * binding state would mean the board went dark whenever the binding was transferred or
 * suspended. The read is therefore project-scoped, which is the boundary the credential
 * actually carries.
 *
 * ## What it adds over the connector list
 *
 * Each row carries its delivery history, so "done" is checkable rather than asserted, and
 * the anchor (`pageUrl`, `queries`, `newPage`) so a client knows which page and which
 * queries the work is about without parsing a title. The title reads `Duplicate title on
 * https://…`; splitting that string to recover the URL is the guessing this project bans.
 */

export type BoardFilters = {
  siteId: string;
  /** One workflow state, or every state when omitted. */
  status?: "detected" | "accepted" | "in_progress" | "delivered" | "parked" | "rejected" | "closed";
  /** Only rows whose evidence class matches. */
  evidenceClass?: "measured" | "estimated" | "technical" | "hypothesis";
  limit: number;
  cursor?: string;
};

export type BoardRow = {
  id: string;
  title: string;
  summary: string;
  status: string;
  type: string;
  evidenceClass: string;
  score: number | null;
  pageUrl: string | null;
  newPage: boolean | null;
  queries: string[];
  executions: ExecutionRecord[];
  firstDetectedAt: string;
  updatedAt: string;
};

export type Board = {
  schemaVersion: "1.0";
  projectId: string;
  siteId: string;
  domain: string;
  opportunities: BoardRow[];
  /** Whole-project counts, so a client can show "13 to decide / 138 parked" from one call. */
  counts: Record<string, number>;
  nextCursor: string | null;
};

/**
 * The order the board uses: evidence class, then score, then oldest first.
 *
 * Deliberately the same order as the product's own board. A client that re-sorted by score
 * alone would put a projection above a measurement, which is the inversion the evidence
 * class exists to prevent — so the order is applied here rather than left to the caller.
 */
const CLASS_RANK: Record<string, number> = { measured: 0, estimated: 1, technical: 2, hypothesis: 3 };

export async function readOpportunityBoard(
  db: Pick<PrismaClient, "opportunity" | "site">,
  projectId: string,
  filters: BoardFilters
): Promise<Board> {
  const site = await db.site.findFirst({
    where: { id: filters.siteId, projectId, retiredAt: null },
    select: { id: true, domain: true },
  });
  if (!site) throw new ExecutionError("Project site not found", 404);

  const where = {
    projectId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.evidenceClass ? { evidenceClass: filters.evidenceClass } : {}),
  };

  // Fetched whole and sorted in memory: the class ordering is a declared rank, not a
  // Postgres enum order, and the enum's own order is alphabetical rather than best-first.
  // The cap is a page, and the page is small by construction.
  const rows = await db.opportunity.findMany({
    where,
    select: {
      id: true,
      title: true,
      summary: true,
      status: true,
      type: true,
      dedupKey: true,
      evidenceClass: true,
      scoreValue: true,
      scoreInputs: true,
      recommendationDecision: true,
      firstDetectedAt: true,
      updatedAt: true,
      opportunityExecutions: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true, executorKind: true, executorId: true, workKind: true,
          commitSha: true, pullRequestUrl: true, deployedUrl: true,
          note: true, resultingStatus: true, createdAt: true,
        },
      },
    },
  });

  const sorted = rows.sort((a, b) => {
    const classDelta = (CLASS_RANK[a.evidenceClass] ?? 9) - (CLASS_RANK[b.evidenceClass] ?? 9);
    if (classDelta !== 0) return classDelta;
    const scoreDelta = (b.scoreValue ?? 0) - (a.scoreValue ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return a.firstDetectedAt.getTime() - b.firstDetectedAt.getTime();
  });

  const start = filters.cursor ? sorted.findIndex((row) => row.id === filters.cursor) + 1 : 0;
  if (filters.cursor && start === 0) throw new ExecutionError("Opportunity cursor does not belong to this project", 400);
  const page = sorted.slice(start, start + filters.limit);

  const grouped = new Map<string, number>();
  for (const row of sorted) grouped.set(row.status, (grouped.get(row.status) ?? 0) + 1);

  return {
    schemaVersion: "1.0",
    projectId,
    siteId: site.id,
    domain: site.domain,
    opportunities: page.map((row) => {
      const anchored = withExecutions(
        row,
        row.opportunityExecutions.map((execution) => ({ ...execution, createdAt: execution.createdAt.toISOString() }))
      );
      return {
        id: row.id,
        title: row.title,
        summary: row.summary,
        status: row.status,
        type: row.type,
        evidenceClass: row.evidenceClass,
        score: row.scoreValue,
        pageUrl: anchored.pageUrl,
        newPage: anchored.newPage,
        queries: anchored.queries,
        executions: anchored.executions,
        firstDetectedAt: row.firstDetectedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    counts: { ...Object.fromEntries(grouped), total: sorted.length },
    nextCursor: start + filters.limit < sorted.length ? page.at(-1)?.id ?? null : null,
  };
}

/** What an executor needs before pushing work for one opportunity. */
export type WorkBrief = {
  schemaVersion: "1.0";
  opportunityId: string;
  title: string;
  summary: string;
  status: string;
  /** The page the work is about, and whether it exists. */
  pageUrl: string | null;
  newPage: boolean | null;
  queries: string[];
  /** The change the recommendation asks for, from the validated decision. */
  action: string | null;
  /** How the owner will know it worked. */
  successMeasure: string | null;
  /** Why this is worth doing, in the producer's own words. */
  rationale: string | null;
  /** Pages the score was computed against. */
  targetPages: string[];
  /**
   * What the page is actually seen for, from Search Console, heaviest first.
   *
   * Empty when the page does not exist yet — a proposal has no measured queries, and saying
   * so is better than listing the queries the model guessed it might rank for.
   */
  pageQueries: PageQuery[];
  /** How many distinct queries the page earned impressions for, before the display limit. */
  pageQueryCount: number;
  /** The measurement window for `pageQueries`, so a reader knows what "28 days" means here. */
  pageQueryWindowDays: number;
  executions: ExecutionRecord[];
};

/**
 * One opportunity as a work brief.
 *
 * Reads only what the row recorded. `action` and `successMeasure` come from the validated
 * recommendation, never from the summary text, and are null when the row predates that
 * contract — a brief that invented them would be worse than one that says it does not know.
 */
export async function readWorkBrief(
  db: Pick<PrismaClient, "opportunity" | "opportunityExecution" | "keyword" | "site">,
  projectId: string,
  opportunityId: string
): Promise<WorkBrief> {
  const row = await db.opportunity.findFirst({
    where: { id: opportunityId, projectId },
    select: {
      id: true,
      title: true,
      summary: true,
      status: true,
      dedupKey: true,
      type: true,
      scoreInputs: true,
      recommendationDecision: true,
    },
  });
  if (!row) throw new ExecutionError("Opportunity not found in this project", 404);

  const anchored = withExecutions(row, []);
  const decision = (row.recommendationDecision ?? {}) as Record<string, unknown>;
  // The queries belong to the page, and the measurement is keyed by site, so the site is
  // resolved from the opportunity's project rather than passed in by the caller.
  const site = await db.site.findFirst({
    where: { projectId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const measured = site
    ? await readPageQueries(db, site.id, anchored.pageUrl)
    : { queries: [], windowDays: 28, totalQueries: 0 };
  const worth = ((row.scoreInputs ?? {}) as { worth?: Record<string, unknown> }).worth ?? {};
  const executions = await listExecutions(db, projectId, opportunityId);

  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  return {
    schemaVersion: "1.0",
    opportunityId: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    pageUrl: anchored.pageUrl,
    newPage: anchored.newPage,
    queries: anchored.queries,
    action: text(decision.action),
    successMeasure: text(decision.successMeasure) ?? text(worth.successMeasure),
    rationale: text(decision.rationale) ?? text(worth.offerFitRationale) ?? text(worth.needRationale),
    targetPages: Array.isArray(worth.targetPages) ? (worth.targetPages as string[]) : [],
    pageQueries: measured.queries,
    pageQueryCount: measured.totalQueries,
    pageQueryWindowDays: measured.windowDays,
    executions,
  };
}

async function listExecutions(
  db: Pick<PrismaClient, "opportunityExecution">,
  projectId: string,
  opportunityId: string
): Promise<ExecutionRecord[]> {
  const rows = await db.opportunityExecution.findMany({
    where: { opportunityId, projectId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((row) => ({
    id: row.id,
    executorKind: row.executorKind,
    executorId: row.executorId,
    workKind: row.workKind,
    commitSha: row.commitSha,
    pullRequestUrl: row.pullRequestUrl,
    deployedUrl: row.deployedUrl,
    note: row.note,
    resultingStatus: row.resultingStatus,
    createdAt: row.createdAt.toISOString(),
  }));
}
