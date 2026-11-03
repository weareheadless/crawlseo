import type { PrismaClient } from "@prisma/client";

import { applyJoin, computeFollowUps, type FollowUpRequest, type JoinDb } from "@/lib/funnel/join";
import type { ScoreInputs } from "@/lib/funnel/scoring";

/**
 * Join follow-up execution (plan §2.3).
 *
 * `computeFollowUps` says which opportunities are one-legged and which collection
 * would join them. This module acts on that:
 *
 *  - a missing **why** leg is joined from owner business knowledge when a fact
 *    shares a meaningful token with the opportunity (declared match, no guessing);
 *  - a missing **how** leg is joined by running the declared collection, which is
 *    paid, so it is capped by an explicit spend ceiling;
 *  - anything without a collection or a match is reported as skipped with the
 *    reason, never silently dropped.
 *
 * The join writes the supporting edge and recomputes the score from stored
 * evidence; the detector is not re-run, so an opportunity cannot change identity
 * underneath the person looking at it.
 */

export type JoinEvidence = {
  id: string;
  kind: string;
  observedAt: Date;
  dimensions: unknown;
  metrics: unknown;
};

export type CollectionResult = { evidence: JoinEvidence[]; spentMicros: number };

/** A collection that can join a missing how leg. Paid, so it reports its cost. */
export type JoinCollector = (input: {
  projectId: string;
  siteId: string | null;
  queries: string[];
}) => Promise<CollectionResult>;

export type JoinCollectors = {
  /** Keyword volumes for a query (O13's how leg). */
  keywordMetrics?: JoinCollector;
  /** SERP composition for a query (O14's how leg). */
  serpSnapshots?: JoinCollector;
  /** AI visibility for a question (O5's how leg). */
  aiVisibility?: JoinCollector;
};

export type JoinRunResult = {
  requests: number;
  joined: Array<{ opportunityId: string; leg: "why" | "how"; evidenceId: string; reason: string }>;
  skipped: Array<{ opportunityId: string; leg: "why" | "how"; reason: string }>;
  spentMicros: number;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "without", "from", "this", "that", "our", "your",
  "les", "des", "une", "aux", "pour", "avec", "sans", "dans", "sur", "est", "sont",
  "page", "pages", "site", "missing", "issue", "issues", "defect", "gap", "rank",
]);

/** Accent-insensitive tokens, long enough to mean something. */
export function tokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token))
  );
}

/** Tokens a knowledge fact offers, including its field name (services, voice, …). */
export function factTokens(fact: JoinEvidence): Set<string> {
  const dimensions = (fact.dimensions ?? {}) as { field?: string; value?: string };
  return tokens(`${dimensions.field ?? ""} ${dimensions.value ?? ""}`);
}

/**
 * Declared match: the fact that shares the most tokens with the opportunity.
 * A tie is not a match — the join stays missing rather than picking arbitrarily.
 */
export function matchKnowledgeFact(
  opportunity: { title: string; summary: string | null; clusterSlug?: string | null },
  facts: JoinEvidence[]
): { fact: JoinEvidence; shared: string[] } | null {
  const wanted = tokens(`${opportunity.title} ${opportunity.summary ?? ""} ${opportunity.clusterSlug ?? ""}`);
  let best: { fact: JoinEvidence; shared: string[] } | null = null;
  for (const fact of facts) {
    const shared = [...factTokens(fact)].filter((token) => wanted.has(token));
    if (shared.length === 0) continue;
    if (!best || shared.length > best.shared.length) best = { fact, shared };
    else if (best && shared.length === best.shared.length) best = null;
  }
  return best;
}

/** Stored score inputs minus the completeness the join recomputes. */
function joinInputs(stored: unknown): Omit<ScoreInputs, "evidenceCompleteness"> | null {
  if (!stored || typeof stored !== "object") return null;
  const { evidenceCompleteness: _ignored, ...rest } = stored as ScoreInputs;
  if (!rest.worth || !rest.winProbability || !rest.effort) return null;
  return rest as Omit<ScoreInputs, "evidenceCompleteness">;
}

type OpportunityRow = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  scoreInputs: unknown;
  evidenceCompleteness: string;
};

export async function runJoinFollowUps(
  db: JoinDb & Pick<PrismaClient, "evidenceRecord" | "demandMapCluster">,
  opts: {
    projectId: string;
    siteId?: string | null;
    maxSpendMicros?: number;
    now?: Date;
    collectors?: JoinCollectors;
  }
): Promise<JoinRunResult> {
  const now = opts.now ?? new Date();
  const ceiling = Math.max(0, opts.maxSpendMicros ?? 0);
  const collectors = opts.collectors ?? {};

  const requests = await computeFollowUps(db, opts.projectId);
  const result: JoinRunResult = { requests: requests.length, joined: [], skipped: [], spentMicros: 0 };
  if (requests.length === 0) return result;

  const opportunities = (await db.opportunity.findMany({
    where: { projectId: opts.projectId, id: { in: requests.map((request) => request.opportunityId) } },
    select: { id: true, type: true, title: true, summary: true, scoreInputs: true, evidenceCompleteness: true, clusterId: true },
  })) as Array<OpportunityRow & { clusterId: string | null }>;
  const byId = new Map(opportunities.map((row) => [row.id, row]));

  const facts = (await db.evidenceRecord.findMany({
    where: { projectId: opts.projectId, kind: "knowledge_fact", supersededById: null },
    select: { id: true, kind: true, observedAt: true, dimensions: true, metrics: true },
  })) as JoinEvidence[];

  const clusters = await db.demandMapCluster.findMany({
    where: { projectId: opts.projectId, id: { in: opportunities.map((row) => row.clusterId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, slug: true },
  });
  const clusterSlug = new Map(clusters.map((row) => [row.id, row.slug]));

  const joinOne = async (
    opportunity: OpportunityRow & { clusterId: string | null },
    leg: "why" | "how",
    evidence: JoinEvidence,
    reason: string
  ) => {
    const inputs = joinInputs(opportunity.scoreInputs);
    if (!inputs) {
      result.skipped.push({ opportunityId: opportunity.id, leg, reason: "stored score inputs are missing" });
      return;
    }
    await applyJoin(db, opportunity.id, evidence, leg, inputs, { joinedBy: "join-runner", now });
    result.joined.push({ opportunityId: opportunity.id, leg, evidenceId: evidence.id, reason });
  };

  const spendRemaining = () => ceiling - result.spentMicros;

  for (const request of requests) {
    const opportunity = byId.get(request.opportunityId);
    if (!opportunity) {
      result.skipped.push({ opportunityId: request.opportunityId, leg: request.missingLeg, reason: "opportunity not found" });
      continue;
    }
    const withCluster = { ...opportunity, clusterSlug: opportunity.clusterId ? clusterSlug.get(opportunity.clusterId) ?? null : null };

    if (request.missingLeg === "why") {
      const match = matchKnowledgeFact(withCluster, facts);
      if (!match) {
        result.skipped.push({ opportunityId: opportunity.id, leg: "why", reason: "no business fact shares a token with this opportunity" });
        continue;
      }
      await joinOne(opportunity, "why", match.fact, `business fact matched on ${match.shared.join(", ")}`);
      continue;
    }

    // Missing how leg: run the declared collection when this type has one.
    const query = opportunity.title.replace(/^[^:]*:\s*/, "").replace(/^"|"$/g, "").slice(0, 120);
    const collector =
      opportunity.type === "O13_user_pain_point" ? collectors.keywordMetrics
        : opportunity.type === "O14_offer_positioning_gap" ? collectors.serpSnapshots
          : opportunity.type === "O5_aeo_presence_gap" ? collectors.aiVisibility
            : undefined;
    if (!collector) {
      result.skipped.push({ opportunityId: opportunity.id, leg: "how", reason: `no collection is defined for ${opportunity.type}` });
      continue;
    }
    if (spendRemaining() <= 0) {
      result.skipped.push({ opportunityId: opportunity.id, leg: "how", reason: "spend ceiling reached" });
      continue;
    }

    const collected = await collector({ projectId: opts.projectId, siteId: opts.siteId ?? null, queries: [query] });
    result.spentMicros += collected.spentMicros;
    const first = collected.evidence[0];
    if (!first) {
      result.skipped.push({ opportunityId: opportunity.id, leg: "how", reason: "collection returned no evidence" });
      continue;
    }
    await joinOne(opportunity, "how", first, `collected ${first.kind}`);
  }

  return result;
}
