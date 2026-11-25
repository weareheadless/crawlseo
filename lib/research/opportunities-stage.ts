import type { PrismaClient } from "@prisma/client";

import {
  critiqueProposals,
  dedupeProposals,
  renderProposalBoard,
  storeProposals,
  type Proposal,
} from "@/lib/research/opportunity-generation";
import { draftProposals, proposalIdentity } from "@/lib/research/opportunity-drafting";
import { topicMapKey, type TopicMap } from "@/lib/research/topic-map";
import {
  buildClusterEvidenceCatalogue,
  selectClusterEvidence,
} from "@/lib/research/opportunity-evidence";

/**
 * The opportunity-drafting stage, as a function rather than a script.
 *
 * Lifted out of `scripts/research-opportunities.ts` so the pipeline and the CLI
 * run one implementation. The only behaviour that changed in the move is that
 * the markdown report is written through an injected writer, so a queued run
 * with no working directory stores the same report in the `ResearchRun` and
 * writes no file.
 */

export type OpportunitiesStageDb = PrismaClient;

export type OpportunitiesStageInput = {
  siteId: string;
  month: string;
  mode: "dry-run" | "execute";
  /** Required for execute, exactly as the CLI requires it. */
  approval?: string | null;
  ai?: boolean;
  refresh?: boolean;
  reports?: { write: (name: string, body: string) => Promise<void> | void } | null;
  onNote?: (message: string) => void;
};

export type OpportunitiesStageResult = {
  status: "completed" | "skipped" | "failed";
  runId: string | null;
  detail: string;
  /** Present so the CLI can print the board without re-reading the run. */
  proposals: Proposal[];
};

/**
 * Fold a query the way the evidence selector does: case, accents and whitespace.
 * Those are facts in every language; a plural or a word order is not.
 */
function foldQuery(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function runOpportunitiesStage(
  db: OpportunitiesStageDb,
  input: OpportunitiesStageInput
): Promise<OpportunitiesStageResult> {
  const note = input.onNote ?? (() => {});
  const { month } = input;
  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { id: true, domain: true, projectId: true, retiredAt: true },
  });
  if (!site) return { status: "failed", runId: null, detail: `site ${input.siteId} not found`, proposals: [] };
  if (site.retiredAt) return { status: "failed", runId: null, detail: `site ${site.domain} is retired`, proposals: [] };
  if (!site.projectId) {
    return { status: "failed", runId: null, detail: `site ${site.domain} is not attached to a project`, proposals: [] };
  }

  // The stage drafts from the stored map. A missing map is not an empty board:
  // it is nothing to draft from, and saying so is the point of the pipeline
  // gate rather than a draft over no clusters.
  const topicRun = await db.researchRun.findFirst({
    where: { siteId: site.id, idempotencyKey: topicMapKey(site.id, month) },
    orderBy: { createdAt: "desc" },
  });
  if (!topicRun) {
    return {
      status: "failed",
      runId: null,
      detail: `no topic map run for ${site.domain} ${month}; the map stage must complete first`,
      proposals: [],
    };
  }
  const map = (topicRun.report as { map?: TopicMap } | null)?.map;
  if (!map) return { status: "failed", runId: null, detail: `topic map run ${topicRun.id} has no map report`, proposals: [] };

  const key = `opportunities:${site.id}:${month}`;
  const existing = await db.researchRun.findFirst({ where: { siteId: site.id, idempotencyKey: key } });
  if (input.mode === "execute" && existing?.status === "COMPLETED" && !input.refresh) {
    return {
      status: "skipped",
      runId: existing.id,
      detail: `existing opportunity run ${existing.id} returned without re-drafting (pass refresh to rebuild)`,
      proposals: ((existing.report as { proposals?: Proposal[] } | null)?.proposals ?? []),
    };
  }

  const [clusters, evidenceRows, knowledge, aeoRows, bundleRun] = await Promise.all([
    db.demandMapCluster.findMany({
      where: { projectId: site.projectId, slug: { in: map.clusters.map((cluster) => cluster.slug) }, supersededAt: null },
      select: { id: true, slug: true },
    }),
    db.evidenceRecord.findMany({
      where: {
        projectId: site.projectId,
        siteId: site.id,
        // `competitor_rank` belongs here. A cluster whose queries were sampled
        // but whose competitors are not sent cannot produce a competitive
        // proposal.
        kind: {
          in: [
            "keyword_rank",
            "keyword_metrics",
            "serp_snapshot",
            "competitor_rank",
            "keyword_universe_membership",
          ],
        },
        supersededById: null,
      },
      select: { id: true, kind: true, dimensions: true, metrics: true, observedAt: true, producer: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id, kind: "knowledge_fact", supersededById: null },
      select: { id: true, dimensions: true },
      take: 6,
    }),
    db.evidenceRecord.findMany({
      where: {
        projectId: site.projectId,
        siteId: site.id,
        kind: "ai_visibility_observation",
        supersededById: null,
        dimensions: { path: ["surface"], equals: "google_ai_overview" },
      },
      select: { id: true, dimensions: true, metrics: true },
    }),
    db.researchRun.findFirst({
      where: { siteId: site.id, idempotencyKey: `monthly:${site.id}:${month}:bundle` },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
  ]);

  /**
   * What the topic review already ruled out, so a paid SERP cannot quietly
   * re-propose it. The map's own `unmapped` list carries the reason.
   */
  const excludedByReview = new Map<string, string>();
  for (const entry of map.unmapped ?? []) {
    if (entry.kind !== "excluded") continue;
    excludedByReview.set(foldQuery(entry.query), entry.reason ?? "excluded by review");
  }
  const evidenceSelection = selectClusterEvidence(map.clusters, evidenceRows, excludedByReview);
  const evidenceByCluster = evidenceSelection.idsByCluster;
  const aeoEvidence = aeoRows.flatMap((row) => {
    const dimensions = row.dimensions as { question?: string } | null;
    const metrics = row.metrics as Record<string, { value?: number }> | null;
    if (!dimensions?.question) return [];
    return [{
      id: row.id,
      question: dimensions.question,
      cited: Number(metrics?.["provider:citedCount"]?.value ?? 0),
      competitorCited: Number(metrics?.["provider:competitorCitedCount"]?.value ?? 0),
    }];
  });
  const news = bundleRun
    ? await db.researchSource.findMany({
        where: { runId: bundleRun.id },
        select: { id: true, title: true, url: true, publishedAt: true, excerpt: true },
        orderBy: { publishedAt: "desc" },
        take: 20,
      })
    : [];
  const technical = await db.opportunity.findMany({
    where: {
      projectId: site.projectId,
      type: { in: ["O7_technical_defect", "O8_structured_data_gap"] },
      status: { in: ["detected", "accepted", "in_progress"] },
    },
    select: { id: true, type: true, title: true, summary: true, scoreValue: true },
    orderBy: { scoreValue: "desc" },
    take: 5,
  });

  // Technical evidence comes from the crawl itself, not from detector rows.
  // Crawl evidence is appended per crawl, so the pack is scoped to the latest
  // crawl: otherwise a fixed defect from a previous crawl keeps being proposed
  // after the recrawl stopped finding it.
  const latestCrawl = await db.crawl.findFirst({
    where: { siteId: site.id, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  const crawlRowTotal = latestCrawl
    ? await db.evidenceRecord.count({
        where: {
          projectId: site.projectId,
          siteId: site.id,
          kind: "onpage_crawl",
          supersededById: null,
          dimensions: { path: ["crawlId"], equals: latestCrawl.id },
        },
      })
    : 0;
  const crawlRows = latestCrawl
    ? await db.evidenceRecord.findMany({
        where: {
          projectId: site.projectId,
          siteId: site.id,
          kind: "onpage_crawl",
          supersededById: null,
          dimensions: { path: ["crawlId"], equals: latestCrawl.id },
        },
        select: { id: true, kind: true, dimensions: true, observedAt: true },
        orderBy: { observedAt: "desc" },
        take: 2000,
      })
    : [];
  // Group by defect: "duplicate description on 59 pages" is one delivery, and
  // the model cannot see that from 12 individual rows.
  const byIssue = new Map<string, { id: string; kind: string; issue: string; url: string; pages: number }>();
  for (const row of crawlRows) {
    const dimensions = row.dimensions as { url?: string; issueType?: string } | null;
    if (!dimensions?.issueType || !dimensions.url) continue;
    const seen = byIssue.get(dimensions.issueType);
    if (seen) {
      seen.pages += 1;
      continue;
    }
    byIssue.set(dimensions.issueType, {
      id: row.id,
      kind: row.kind,
      issue: dimensions.issueType,
      url: dimensions.url,
      pages: 1,
    });
  }
  const technicalEvidence = [...byIssue.values()]
    .sort((a, b) => b.pages - a.pages)
    .slice(0, 8)
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      issue: entry.issue,
      query: null,
      position: null,
      impressions: null,
      volume: null,
      url: entry.url,
      pages: entry.pages,
    }));

  // Every indexable path the site already has. The drafting call uses it to
  // tell "create this page" from "this page already exists, update it".
  const auditPages = latestCrawl
    ? await db.auditPage.findMany({
        where: { crawlId: latestCrawl.id, statusCode: 200 },
        select: { url: true },
      })
    : [];
  const existingPaths = [...new Set(auditPages.flatMap((page) => {
    try {
      return [new URL(page.url).pathname.replace(/\/+$/, "") || "/"];
    } catch {
      return [];
    }
  }))];

  const evidenceCatalogue = buildClusterEvidenceCatalogue(map.clusters, evidenceRows, evidenceByCluster);
  const draft = await draftProposals({
    map,
    marketScope: map.marketScope,
    evidenceByCluster: evidenceCatalogue,
    // Queries no topic could claim still reach the model, with who holds them.
    unfiledCompetitors: evidenceSelection.unfiled,
    aeoQuestions: aeoEvidence.map((row) => ({
      id: row.id,
      question: row.question,
      cited: row.cited,
      competitors: row.competitorCited,
    })),
    news: news.map((row) => ({
      id: row.id,
      title: row.title ?? "",
      url: row.url,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      excerpt: row.excerpt,
    })),
    knowledgeEvidenceIds: knowledge.map((row) => row.id),
    existingPaths,
    knowledgeFacts: knowledge.map((row) => {
      const dimensions = row.dimensions as { field?: string; value?: string } | null;
      const field = dimensions?.field ?? "business fact";
      const value = dimensions?.value ?? "";
      return {
        id: row.id,
        kind: "knowledge_fact",
        query: null,
        position: null,
        impressions: null,
        volume: null,
        url: null,
        text: value ? `${field}: ${value}` : field,
      };
    }),
    technicalEvidence,
    now: new Date(),
  });
  // Identity is the asset the proposal touches, so a re-worded proposal
  // updates its row instead of adding a second one.
  const proposals = dedupeProposals(
    draft.proposals.map((proposal) => ({ ...proposal, dedupKey: proposalIdentity(proposal) }))
  );

  if (input.mode === "dry-run") {
    if (input.reports) {
      await input.reports.write(
        `${site.domain}-opportunities-${month}.md`,
        renderProposalBoard({
          map,
          proposals,
          dropped: [],
          critique: {
            available: false,
            model: draft.model,
            summary: null,
            error: draft.errors.length > 0 ? draft.errors.join("; ") : "dry run: no critique",
          },
          technical,
          generatedAt: new Date().toISOString(),
        })
      );
    }
    return {
      status: "completed",
      runId: existing?.id ?? null,
      detail: `dry run: ${proposals.length} proposals drafted, nothing stored`,
      proposals,
    };
  }

  const approval = input.approval?.trim();
  if (!approval) {
    return { status: "failed", runId: null, detail: "execute requires an approval reference", proposals };
  }

  let critique: {
    available: boolean;
    model: string | null;
    summary: string | null;
    error: string | null;
    decisions: Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>;
  } = {
    available: false,
    model: draft.model,
    summary: null,
    error: draft.errors.length > 0 ? draft.errors.join("; ") : null,
    decisions: new Map(),
  };
  if (input.ai && proposals.length > 0) {
    critique = await critiqueProposals(proposals, map);
    if (!critique.available) note(`critique unavailable: ${critique.error ?? "unknown error"}`);
  }

  // The model's proposals are stored as drafted. Code does not merge, group or
  // re-target them; the critique is advice carried on the row, not a second
  // decision.
  const dropped: Array<{ title: string; reason: string }> = [...draft.rejected];
  const kept: Proposal[] = proposals.map((proposal) => {
    const decision = critique.decisions.get(proposal.dedupKey);
    // A critique drop is advice, not an automatic removal. The proposal stays
    // on the board with the drop reason so the owner can decide.
    return {
      ...proposal,
      critique: decision ? { verdict: decision.verdict, reason: decision.reason } : null,
    };
  });

  const allEvidenceRows = await db.evidenceRecord.findMany({
    where: { projectId: site.projectId, siteId: site.id },
    select: { id: true },
  });
  const evidenceIds = new Set(allEvidenceRows.map((row) => row.id));
  // "High confidence" has to rest on first-party data. Provider volume is a
  // market estimate; the crawl and Search Console are the site. This covers
  // every first-party row, including the crawl rows a technical proposal cites.
  const firstPartyRows = await db.evidenceRecord.findMany({
    where: {
      projectId: site.projectId,
      siteId: site.id,
      producer: { in: ["search_console", "crawler"] },
      supersededById: null,
    },
    select: { id: true },
  });
  const firstPartyEvidenceIds = new Set(firstPartyRows.map((row) => row.id));
  const stored = await storeProposals(db, {
    projectId: site.projectId,
    siteId: site.id,
    domain: site.domain,
    map,
    topicMapRunId: topicRun.id,
    proposals: kept,
    evidenceIds,
    firstPartyEvidenceIds,
    knowledgeEvidenceIds: knowledge.map((row) => row.id),
    clusters,
  });
  dropped.push(...stored.dropped);
  const keptKeys = kept.map((proposal) => proposal.dedupKey);

  // Proposals this run no longer makes are superseded, not deleted: the row and
  // its evidence stay for audit.
  const previousPhase3 = await db.opportunity.findMany({
    where: { projectId: site.projectId, detectedBy: "phase3:topic-map", status: "detected" },
    select: { id: true, dedupKey: true },
  });
  const keepSet = new Set(keptKeys);
  const stale = previousPhase3.filter((row) => !keepSet.has(row.dedupKey));
  if (stale.length > 0) {
    await db.opportunity.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: { status: "parked", parkReason: "superseded by refreshed proposal" },
    });
  }
  if (keptKeys.length > 0) {
    // A proposal the AI previously recommended dropping but now keeps comes
    // back; a human rejection or an expired item does not.
    await db.opportunity.updateMany({
      where: {
        projectId: site.projectId,
        dedupKey: { in: keptKeys },
        status: "closed",
        parkReason: "dropped by critique",
      },
      data: { status: "detected", parkReason: null },
    });
  }

  // Churn is the thing to watch on a re-run: the same asset keeps its row, but a
  // new asset for the same job looks like a fresh recommendation.
  const previousProposals = ((existing?.report as { proposals?: Array<{ dedupKey: string; title: string }> } | null)?.proposals ?? []);
  const previousKeys = new Set(previousProposals.map((proposal) => proposal.dedupKey));
  const currentKeys = new Set(kept.map((proposal) => proposal.dedupKey));
  const changes = {
    updated: kept.filter((proposal) => previousKeys.has(proposal.dedupKey)).length,
    added: kept.filter((proposal) => !previousKeys.has(proposal.dedupKey)).map((proposal) => proposal.title),
    // Not re-proposed this run, not verified fixed. Closure has its own state.
    noLongerProposed: previousProposals.filter((proposal) => !currentKeys.has(proposal.dedupKey)).map((proposal) => proposal.title),
  };

  const report = {
    version: 1,
    changes,
    map: { siteId: map.siteId, domain: map.domain, month: map.month },
    proposals: kept,
    dropped,
    drafting: {
      model: draft.model,
      summary: draft.summary,
      errors: draft.errors,
      truncations: [
        ...draft.truncations,
        // The competitor-context bounds drop queries by design. Say how many,
        // per cluster, so a bound never reads as "there was nothing there".
        ...evidenceSelection.truncations,
        // The crawl read is bounded by a constant; say so when it binds.
        ...(crawlRowTotal > crawlRows.length
          ? [`${crawlRowTotal - crawlRows.length} crawl findings were not sent to the drafting call`]
          : []),
      ],
    },
    critique: {
      available: critique.available,
      model: critique.model,
      summary: critique.summary,
      error: critique.error,
    },
    technical,
    stored,
    approvalReference: approval,
    generatedAt: new Date().toISOString(),
    counts: {
      proposals: kept.length,
      stored: stored.stored.length,
      dropped: dropped.length,
      byLane: kept.reduce<Record<string, number>>((acc, proposal) => {
        acc[proposal.lane] = (acc[proposal.lane] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };

  const runData = {
    siteId: site.id,
    projectId: site.projectId,
    kind: "SEO" as const,
    trigger: "MANUAL" as const,
    status: "COMPLETED" as const,
    title: `Opportunity proposals — ${month}`,
    brief: { month, topicMapRunId: topicRun.id, approvalReference: approval, ai: Boolean(input.ai) } as never,
    topics: kept.map((proposal) => proposal.title).slice(0, 12) as never,
    recencyDays: 31,
    promptVersion: "opportunities-v1",
    idempotencyKey: key,
    requestedBy: "research-pipeline",
    startedAt: new Date(),
    completedAt: new Date(),
    report: report as never,
    sourceCount: news.length,
    findingCount: 0,
    actionCount: 0,
    costMicros: 0,
  };
  const runId = existing
    ? (await db.researchRun.update({ where: { id: existing.id }, data: runData, select: { id: true } })).id
    : (await db.researchRun.create({ data: runData, select: { id: true } })).id;

  if (input.reports) {
    await input.reports.write(
      `${site.domain}-opportunities-${month}.md`,
      renderProposalBoard({
        map,
        proposals: kept,
        dropped,
        critique: report.critique,
        drafting: report.drafting,
        changes: report.changes,
        reproposedClosed: stored.reproposedClosed,
        technical,
        generatedAt: report.generatedAt,
      })
    );
  }

  return {
    status: "completed",
    runId,
    detail: `${kept.length} proposals, ${stored.stored.length} stored, ${dropped.length} dropped`,
    proposals: kept,
  };
}
