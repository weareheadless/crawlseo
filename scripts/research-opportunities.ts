/**
 * Phase 3 opportunity proposals for one site/month.
 *
 *   npx tsx scripts/research-opportunities.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/research-opportunities.ts --site <siteId> --month 2026-11 \
 *     --execute --approval <reference> [--ai] [--refresh]
 *
 * Both modes draft proposals from the stored topic map with the model, because
 * the board's copy, targets and confidence come from the evidence rather than
 * from a template. Dry run prints them and writes nothing; execute stores them
 * in the existing Opportunity table. `--ai` adds one critique review, which can
 * challenge a proposal but cannot add queries, pages or evidence.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  critiqueProposals,
  dedupeProposals,
  renderProposalBoard,
  storeProposals,
  type Proposal,
  type ProposalConfidence,
} from "@/lib/research/opportunity-generation";
import { draftProposals, proposalIdentity } from "@/lib/research/opportunity-drafting";
import { topicMapKey, type TopicMap } from "@/lib/research/topic-map";
import {
  buildClusterEvidenceCatalogue,
  buildClusterEvidenceIds,
} from "@/lib/research/opportunity-evidence";

loadEnvConfig(process.cwd());

type Args = {
  siteId: string;
  month?: string;
  mode: "dry-run" | "execute";
  approval?: string;
  ai: boolean;
  refresh: boolean;
  out?: string;
  json: boolean;
};

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "CliError";
  }
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new CliError(`unexpected argument ${arg}`, 2);
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      values.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(name);
      continue;
    }
    values.set(name, next);
    index += 1;
  }
  const siteId = values.get("site");
  if (!siteId) throw new CliError("--site <siteId> is required", 2);
  const dryRun = flags.has("dry-run");
  const execute = flags.has("execute");
  if (dryRun === execute) throw new CliError("choose exactly one of --dry-run or --execute", 2);
  return {
    siteId,
    month: values.get("month"),
    mode: execute ? "execute" : "dry-run",
    approval: values.get("approval"),
    ai: flags.has("ai"),
    refresh: flags.has("refresh"),
    out: values.get("out"),
    json: flags.has("json"),
  };
}

function printProposals(proposals: Proposal[]): void {
  for (const proposal of proposals) {
    process.stdout.write(
      `- [${proposal.lane}/${proposal.kind}] ${proposal.title} · ${proposal.effort}/${proposal.confidence} · target ${proposal.target.url ?? (proposal.target.newAsset ? "new asset" : "none")}\n`
    );
    process.stdout.write(`    ${proposal.summary}\n`);
    if (proposal.whyNow) process.stdout.write(`    why now: ${proposal.whyNow}\n`);
    process.stdout.write(`    action: ${proposal.action}\n`);
  }
}


async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const site = await db.site.findUnique({
      where: { id: args.siteId },
      select: { id: true, domain: true, projectId: true, retiredAt: true },
    });
    if (!site) throw new CliError(`site ${args.siteId} not found`, 2);
    if (site.retiredAt) throw new CliError(`site ${site.domain} is retired`, 2);
    if (!site.projectId) throw new CliError(`site ${site.domain} is not attached to a project`, 2);
    const month = args.month?.trim() || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new CliError("--month must be YYYY-MM", 2);

    const topicRun = await db.researchRun.findFirst({
      where: { siteId: site.id, idempotencyKey: topicMapKey(site.id, month) },
      orderBy: { createdAt: "desc" },
    });
    if (!topicRun) throw new CliError(`no topic map run for ${site.domain} ${month}; run research-topic-map first`, 4);
    const topicReport = topicRun.report as { map?: TopicMap } | null;
    const map = topicReport?.map;
    if (!map) throw new CliError(`topic map run ${topicRun.id} has no map report`, 4);

    const [clusters, evidenceRows, knowledge, aeoRows, bundleRun] = await Promise.all([
      db.demandMapCluster.findMany({
        where: { projectId: site.projectId, slug: { in: map.clusters.map((cluster) => cluster.slug) }, supersededAt: null },
        select: { id: true, slug: true },
      }),
      db.evidenceRecord.findMany({
        where: {
          projectId: site.projectId,
          siteId: site.id,
          kind: { in: ["keyword_rank", "keyword_metrics", "serp_snapshot", "keyword_universe_membership"] },
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

    const evidenceByCluster = buildClusterEvidenceIds(map.clusters, evidenceRows);
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
    // Technical evidence comes from the crawl itself, not from the legacy
    // detector rows. Crawl evidence is appended per crawl, so the pack must be
    // scoped to the latest crawl: otherwise a fixed defect from a previous
    // crawl keeps being proposed after the recrawl stopped finding it.
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
      const existing = byIssue.get(dimensions.issueType);
      if (existing) {
        existing.pages += 1;
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
    const latestCrawlForPages = await db.crawl.findFirst({
      where: { siteId: site.id, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });
    const auditPages = latestCrawlForPages
      ? await db.auditPage.findMany({
          where: { crawlId: latestCrawlForPages.id, statusCode: 200 },
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
    const key = `opportunities:${site.id}:${month}`;
    const existing = await db.researchRun.findFirst({ where: { siteId: site.id, idempotencyKey: key } });
    if (args.mode === "execute" && existing?.status === "COMPLETED" && !args.refresh) {
      if (args.json) process.stdout.write(`${JSON.stringify({ status: "existing", runId: existing.id, report: existing.report }, null, 2)}\n`);
      else process.stdout.write(`existing opportunity run: ${existing.id}; use --refresh to rebuild\n`);
      process.exitCode = 0;
      return;
    }

    const outPath = args.out ?? path.join("docs", `${site.domain.replace(/[^a-z0-9.-]+/gi, "-")}-opportunities-${month}.md`);
    if (args.mode === "dry-run") {
      await writeFile(
        outPath,
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
        }),
        "utf8"
      );
      if (args.json) process.stdout.write(`${JSON.stringify({ status: "planned", proposals, technical }, null, 2)}\n`);
      else {
        printProposals(proposals);
        process.stdout.write(`report: ${outPath}\n`);
      }
      process.exitCode = 0;
      return;
    }

    const approval = args.approval?.trim();
    if (!approval) throw new CliError("--execute requires --approval <reference>", 2);

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
    if (args.ai && proposals.length > 0) {
      critique = await critiqueProposals(proposals, map);
      if (!critique.available) process.stderr.write(`critique unavailable: ${critique.error ?? "unknown error"}\n`);
    }

    // The model's proposals are stored as drafted. Code does not merge, group
    // or re-target them; the critique is advice carried on the row, not a
    // second decision.
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
    // every first-party row, including the crawl rows a technical proposal
    // cites, not only the cluster evidence loaded above.
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

    // Proposals this run no longer makes are superseded, not deleted: the row
    // and its evidence stay for audit.
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
      // A proposal that the AI previously recommended dropping but now keeps
      // comes back; a human rejection or an expired item does not.
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

    // Churn is the thing to watch on a re-run: the same asset keeps its row,
    // but a new asset for the same job looks like a fresh recommendation.
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
      brief: { month, topicMapRunId: topicRun.id, approvalReference: approval, ai: args.ai } as never,
      topics: kept.map((proposal) => proposal.title).slice(0, 12) as never,
      recencyDays: 31,
      promptVersion: "opportunities-v1",
      idempotencyKey: key,
      requestedBy: "research-opportunities-cli",
      startedAt: new Date(),
      completedAt: new Date(),
      report: report as never,
      sourceCount: news.length,
      findingCount: 0,
      actionCount: 0,
      costMicros: 0,
    };
    let runId: string;
    if (existing) {
      const updated = await db.researchRun.update({ where: { id: existing.id }, data: runData, select: { id: true } });
      runId = updated.id;
    } else {
      const created = await db.researchRun.create({ data: runData, select: { id: true } });
      runId = created.id;
    }

    await writeFile(
      outPath,
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
      }),
      "utf8"
    );

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ status: "completed", runId, report }, null, 2)}\n`);
    } else {
      printProposals(kept);
      process.stdout.write(`stored: ${stored.stored.length} proposals; dropped: ${dropped.length}\n`);
      process.stdout.write(`run: ${runId}\nreport: ${outPath}\n`);
    }
    process.exitCode = 0;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
