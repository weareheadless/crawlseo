import type { PrismaClient } from "@prisma/client";

import { queryMatchesTaxonomy, type TopicTaxonomy } from "@/lib/research/topic-taxonomy";

/**
 * Demand forms research observed, ready to be measured.
 *
 * A research finding names the need in the buyer's words (`primary_query`) and
 * the other forms people use (`demandQueries`). Those are hypotheses about
 * demand, not measurements: this module only collects them from evidence that is
 * already stored, gates them against the approved taxonomy, and counts what it
 * had to leave out. Paid measurement decides whether a form is real demand.
 *
 * This reads the same `research_finding` evidence the funnel reasons from, so
 * there is no second research store and no candidate table.
 */

/** How long a proposed form stays a candidate. Longer than one bundle cycle. */
export const DEMAND_CANDIDATE_WINDOW_DAYS = 120;
/** Bound on the phrases handed to the planner; the planner's cap does the rest. */
export const DEMAND_CANDIDATE_LIMIT = 20;

export type ResearchCandidateSelection = {
  /** Forms an approved topic claims, newest finding first, deduplicated. */
  candidates: string[];
  /** Forms no approved topic claims: a taxonomy decision is needed first. */
  unclaimed: string[];
  /** Claimed forms beyond the named limit, counted rather than dropped silently. */
  omitted: number;
  /** Every distinct form observed, claimed or not. */
  available: number;
};

type CandidateDb = Pick<PrismaClient, "evidenceRecord">;

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Shape only: a phrase, not a paragraph. Meaning stays the model's job. */
function usable(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.length <= 70;
}

export function demandCandidateSince(now: Date, windowDays = DEMAND_CANDIDATE_WINDOW_DAYS): Date {
  return new Date(now.getTime() - Math.max(1, windowDays) * 86_400_000);
}

export async function researchCandidateQueries(
  db: CandidateDb,
  input: {
    projectId: string;
    siteId: string;
    since: Date;
    taxonomy: TopicTaxonomy | null;
    limit?: number;
  }
): Promise<ResearchCandidateSelection> {
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: "research_finding",
      supersededById: null,
      observedAt: { gte: input.since },
    },
    select: { dimensions: true },
    orderBy: { observedAt: "desc" },
  });

  const seen = new Set<string>();
  const claimed: string[] = [];
  const unclaimed: string[] = [];
  for (const row of rows) {
    const dimensions = (row.dimensions ?? {}) as { query?: unknown; demandQueries?: unknown };
    const forms = [
      dimensions.query,
      ...(Array.isArray(dimensions.demandQueries) ? dimensions.demandQueries : []),
    ];
    for (const form of forms) {
      if (!usable(form)) continue;
      const key = normalize(form);
      if (seen.has(key)) continue;
      seen.add(key);
      if (queryMatchesTaxonomy(input.taxonomy, form)) claimed.push(form.trim());
      else unclaimed.push(form.trim());
    }
  }

  const limit = Math.max(1, input.limit ?? DEMAND_CANDIDATE_LIMIT);
  return {
    candidates: claimed.slice(0, limit),
    unclaimed,
    omitted: Math.max(0, claimed.length - limit),
    available: claimed.length + unclaimed.length,
  };
}
