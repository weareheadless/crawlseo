import type { PrismaClient } from "@prisma/client";

import { knowledgeFieldList, knowledgeFieldText } from "@/lib/projects/business-knowledge-facts";
import { loadJobMap, proposeJobMap, saveJobMap, type JobMap } from "@/lib/research/job-map";
import {
  buildTopicMap,
  loadTopicMapData,
  storeTopicMap,
  synthesizeTopicMap,
  topicMapChecksum,
  topicMapKey,
  type TopicMap,
} from "@/lib/research/topic-map";
import { projectTopicTaxonomy, saveTopicTaxonomy, type TopicTaxonomy } from "@/lib/research/topic-taxonomy";
import { recordTaxonomyApproval } from "@/lib/research/taxonomy-review";
import { providerCountry } from "@/lib/site/context";

/**
 * One semantic pass over a site's demand: the job map decides the jobs and their
 * topic fields, the taxonomy is its projection, and the map is built from both.
 *
 * The CLI (`scripts/research-topic-map.ts`) and the worker's site cycle call
 * this same function, so an automatic map and a hand-run one cannot diverge.
 * The library does not write files or print: the CLI renders the artefacts, the
 * scheduler records the run.
 *
 * `approval` records who accepted the taxonomy. `auto:<source>` means the model
 * approved it and a person has not reviewed it yet; the stored review marker
 * keeps that visible until someone acknowledges it.
 */

export type RunTopicMapInput = {
  siteId: string;
  month?: string;
  mode: "dry-run" | "execute";
  /** Stored with the run. `auto:` prefixes are treated as not human-reviewed. */
  approval?: string | null;
  /** Run the one synthesis review of the finished map. */
  ai?: boolean;
  /** Rebuild a map that already completed for this month. */
  refresh?: boolean;
  /** Propose a new job map even when one is stored. */
  refreshJobMap?: boolean;
  now?: Date;
};

export type RunTopicMapResult = {
  status: "planned" | "completed" | "existing";
  month: string;
  site: { id: string; domain: string; projectId: string };
  /** Absent when an existing run was reused. */
  jobMap: JobMap | null;
  taxonomy: TopicTaxonomy | null;
  map: TopicMap | null;
  runId: string | null;
  report: unknown;
  stored: { created: number; updated: number; superseded: number; memberships: number } | null;
  approvalReference: string | null;
  /** Non-fatal facts the operator should see (rejected rows, unassigned queries). */
  warnings: string[];
};

type TopicMapRunDb = PrismaClient;

export class TopicMapRunError extends Error {
  constructor(message: string, readonly exitCode = 4) {
    super(message);
    this.name = "TopicMapRunError";
  }
}

function monthOf(value: string | undefined, now: Date): string {
  const month = value?.trim() || now.toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TopicMapRunError("month must be YYYY-MM", 2);
  return month;
}

export async function runTopicMap(db: TopicMapRunDb, input: RunTopicMapInput): Promise<RunTopicMapResult> {
  const now = input.now ?? new Date();
  const month = monthOf(input.month, now);
  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { id: true, domain: true, projectId: true, retiredAt: true },
  });
  if (!site) throw new TopicMapRunError(`site ${input.siteId} not found`, 2);
  if (site.retiredAt) throw new TopicMapRunError(`site ${site.domain} is retired`, 2);
  if (!site.projectId) throw new TopicMapRunError(`site ${site.domain} is not attached to a project`, 2);

  const siteRef = { id: site.id, domain: site.domain, projectId: site.projectId };
  const key = topicMapKey(site.id, month);
  const existing = await db.researchRun.findFirst({ where: { siteId: site.id, idempotencyKey: key } });
  if (existing && existing.status === "COMPLETED" && !input.refresh) {
    return {
      status: "existing", month, site: siteRef, jobMap: null, taxonomy: null, map: null,
      runId: existing.id, report: existing.report ?? null, stored: null,
      approvalReference: (existing.brief as { approvalReference?: string } | null)?.approvalReference ?? null,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const rawData = await loadTopicMapData(db, site.id, month, null);
  let jobMap: JobMap | null = await loadJobMap(db, site.id);
  if (!jobMap || input.refreshJobMap) {
    const proposed = await proposeJobMap({
      domain: site.domain,
      language: rawData.context.language,
      country: providerCountry(rawData.context),
      market: rawData.context.market,
      audienceMarket: rawData.context.audienceMarket,
      audienceCountry: rawData.context.audienceCountry,
      audienceCountries: rawData.context.audienceCountries,
      audienceLanguages: rawData.context.audienceLanguages,
      business: {
        name: knowledgeFieldText(rawData.fields, "businessName"),
        services: knowledgeFieldList(rawData.fields, "services"),
        location: knowledgeFieldText(rawData.fields, "location"),
        serviceArea: knowledgeFieldList(rawData.fields, "serviceArea"),
        audience: rawData.context.audience ?? knowledgeFieldText(rawData.fields, "audienceMotivations"),
        audienceMotivations: knowledgeFieldList(rawData.fields, "audienceMotivations"),
        differentiators: knowledgeFieldList(rawData.fields, "differentiators"),
        concerns: knowledgeFieldList(rawData.fields, "concerns"),
      },
      offers: rawData.marketScope.offers,
      pages: [...rawData.pages]
        .sort((a, b) => b.wordCount - a.wordCount)
        .map((page) => ({ path: page.path, title: page.title, h1: page.h1, wordCount: page.wordCount })),
      queries: rawData.queries.map((query) => ({ query: query.query, impressions: query.impressions, volume: query.volume })),
      previous: jobMap,
    });
    if (!proposed.jobMap) {
      throw new TopicMapRunError(`could not propose a job map for ${site.domain}: ${proposed.error ?? "unknown error"}`);
    }
    jobMap = proposed.jobMap;
    for (const row of proposed.rejected) warnings.push(`job map row skipped: ${row.title} — ${row.reason}`);
    if (proposed.unassigned.length > 0) {
      warnings.push(`job map left ${proposed.unassigned.length} tranche queries unassigned: ${proposed.unassigned.slice(0, 10).join(", ")}`);
    }
    if (input.mode === "execute") await saveJobMap(db, site.id, jobMap);
  }

  const taxonomy = projectTopicTaxonomy(jobMap);
  if (input.mode === "execute") await saveTopicTaxonomy(db, site.id, taxonomy);

  const data = await loadTopicMapData(db, site.id, month, taxonomy);
  const map = buildTopicMap(data, taxonomy.topics, undefined, jobMap);

  if (input.mode === "dry-run") {
    return {
      status: "planned", month, site: siteRef, jobMap, taxonomy, map, runId: existing?.id ?? null,
      report: null, stored: null, approvalReference: input.approval ?? null, warnings,
    };
  }

  if (input.ai) {
    map.ai = await synthesizeTopicMap(map, map.business);
    if (!map.ai.available) warnings.push(`AI review unavailable: ${map.ai.error ?? "unknown error"}`);
  }

  const stored = await storeTopicMap(db, map);
  const report = {
    version: 1,
    map,
    checksum: topicMapChecksum(map),
    stored,
    approvalReference: input.approval ?? null,
    ai: map.ai,
    note: map.ai.available
      ? "One context-synthesis review was run. The provider does not report token usage to this client, so no AI cost is recorded against the DataForSEO budget."
      : "No AI review was run; the deterministic map is stored as-is.",
  };
  const runData = {
    siteId: site.id,
    projectId: site.projectId,
    kind: "SEO" as const,
    trigger: (input.approval?.startsWith("auto:") ? "SCHEDULED" : "MANUAL") as "SCHEDULED" | "MANUAL",
    status: "COMPLETED" as const,
    title: `Topic map — ${month}`,
    brief: { month, taxonomy: "stored-v1", ai: Boolean(input.ai), approvalReference: input.approval ?? null } as never,
    topics: map.clusters.map((cluster) => cluster.name) as never,
    recencyDays: 31,
    promptVersion: "topic-map-v1",
    idempotencyKey: key,
    requestedBy: input.approval?.startsWith("auto:") ? "site-cycle" : "research-topic-map-cli",
    startedAt: now,
    completedAt: now,
    report: report as never,
    sourceCount: map.counts.news,
    findingCount: 0,
    actionCount: 0,
    costMicros: 0,
  };
  const runId = existing
    ? (await db.researchRun.update({ where: { id: existing.id }, data: { ...runData, status: "COMPLETED" }, select: { id: true } })).id
    : (await db.researchRun.create({ data: runData, select: { id: true } })).id;

  // A stored taxonomy is usable immediately, but an automatic approval says a
  // person should still look at it. The marker is what the UI reads.
  await recordTaxonomyApproval(db, site.id, {
    approvedBy: input.approval ?? "cli",
    runId,
    month,
    generatedAt: taxonomy.generatedAt,
    now,
  });

  return {
    status: "completed", month, site: siteRef, jobMap, taxonomy, map, runId,
    report, stored, approvalReference: input.approval ?? null, warnings,
  };
}
