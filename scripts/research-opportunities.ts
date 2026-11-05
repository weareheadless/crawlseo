/**
 * Phase 3 opportunity proposals for one site/month.
 *
 *   npx tsx scripts/research-opportunities.ts --site <siteId> --month 2026-11 --dry-run
 *   npx tsx scripts/research-opportunities.ts --site <siteId> --month 2026-11 \
 *     --execute --approval <reference> [--ai] [--refresh]
 *
 * Dry run builds the proposals from the stored topic map and prints them; it
 * makes no AI call and writes nothing. Execute stores the proposals in the
 * existing Opportunity table. `--ai` runs one critique review; it can drop or
 * challenge a proposal but cannot add queries, pages or evidence.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildDeterministicProposals,
  critiqueProposals,
  renderProposalBoard,
  storeProposals,
  type Proposal,
  type ProposalInputs,
} from "@/lib/research/opportunity-generation";
import { topicMapKey, type TopicMap } from "@/lib/research/topic-map";

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

    const [clusters, memberships, knowledge, aeoRows, bundleRun] = await Promise.all([
      db.demandMapCluster.findMany({
        where: { projectId: site.projectId, slug: { in: map.clusters.map((cluster) => cluster.slug) }, supersededAt: null },
        select: { id: true, slug: true },
      }),
      db.evidenceRecord.findMany({
        where: { projectId: site.projectId, siteId: site.id, kind: "keyword_universe_membership", supersededById: null, producer: "topic-map-v1" },
        select: { id: true, dimensions: true },
      }),
      db.evidenceRecord.findMany({
        where: { projectId: site.projectId, siteId: site.id, kind: "knowledge_fact", supersededById: null },
        select: { id: true },
        take: 4,
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

    const evidenceByCluster = new Map<string, string[]>();
    for (const row of memberships) {
      const dimensions = row.dimensions as { cluster?: string } | null;
      if (!dimensions?.cluster) continue;
      evidenceByCluster.set(dimensions.cluster, [...(evidenceByCluster.get(dimensions.cluster) ?? []), row.id].slice(0, 8));
    }
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

    const inputs: ProposalInputs = {
      site: { id: site.id, domain: site.domain, projectId: site.projectId },
      map,
      topicMapRunId: topicRun.id,
      clusters,
      evidenceByCluster,
      knowledgeEvidenceIds: knowledge.map((row) => row.id),
      aeoEvidence,
      news: news.map((row) => ({
        id: row.id,
        title: row.title ?? "",
        url: row.url,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        excerpt: row.excerpt,
      })),
      technical,
    };

    const proposals = buildDeterministicProposals(inputs);
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
          critique: { available: false, model: null, summary: null, error: "dry run: no critique" },
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

    let critique = { available: false, model: null as string | null, summary: null as string | null, error: null as string | null, decisions: new Map() };
    if (args.ai) {
      critique = await critiqueProposals(proposals, map);
      if (!critique.available) process.stderr.write(`critique unavailable: ${critique.error ?? "unknown error"}\n`);
    }

    const kept: Proposal[] = [];
    const dropped: Array<{ title: string; reason: string }> = [];
    const droppedKeys: string[] = [];
    for (const proposal of proposals) {
      const decision = critique.decisions.get(proposal.dedupKey);
      if (decision?.verdict === "drop") {
        dropped.push({ title: proposal.title, reason: decision.reason });
        droppedKeys.push(proposal.dedupKey);
        continue;
      }
      kept.push({
        ...proposal,
        critique: decision ? { verdict: decision.verdict, reason: decision.reason } : null,
      });
    }

    const evidenceRows = await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id },
      select: { id: true },
    });
    const evidenceIds = new Set(evidenceRows.map((row) => row.id));
    const stored = await storeProposals(db, {
      projectId: site.projectId,
      siteId: site.id,
      domain: site.domain,
      map,
      topicMapRunId: topicRun.id,
      proposals: kept,
      evidenceIds,
      knowledgeEvidenceIds: knowledge.map((row) => row.id),
      clusters,
    });
    dropped.push(...stored.dropped);
    if (droppedKeys.length > 0) {
      await db.opportunity.updateMany({
        where: {
          projectId: site.projectId,
          dedupKey: { in: droppedKeys },
          status: { in: ["detected", "parked"] },
        },
        data: { status: "closed", parkReason: "dropped by critique" },
      });
    }

    const report = {
      version: 1,
      map: { siteId: map.siteId, domain: map.domain, month: map.month },
      proposals: kept,
      dropped,
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
