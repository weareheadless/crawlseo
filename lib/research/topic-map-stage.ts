import type { PrismaClient } from "@prisma/client";

import { providerCountry } from "@/lib/site/context";
import {
  loadJobMap,
  proposeJobMap,
  saveJobMap,
  type JobMap,
} from "@/lib/research/job-map";
import {
  buildTopicMap,
  loadTopicMapData,
  renderTopicMapMarkdown,
  storeTopicMap,
  synthesizeTopicMap,
  topicMapChecksum,
  topicMapKey,
  type TopicMap,
} from "@/lib/research/topic-map";
import { projectTopicTaxonomy, saveTopicTaxonomy } from "@/lib/research/topic-taxonomy";
import { mapStaleness, readTopicMapStaleness } from "@/lib/research/map-staleness";

/**
 * The topic-map stage, as a function rather than a script.
 *
 * It was lifted out of `scripts/research-topic-map.ts` unchanged so the pipeline
 * and the CLI cannot drift: there is one implementation of "build and store the
 * map for this site and month", and both entry points call it. A second copy of
 * this logic is how a map ends up built from different inputs in two places.
 *
 * The stage writes the map report as a file only when `reports` is given. A
 * queued pipeline has no working directory to write `docs/` into, so it passes
 * nothing and the report lives in the `ResearchRun` where the board reads it.
 */

export type TopicMapStageDb = PrismaClient;

export type TopicMapStageInput = {
  siteId: string;
  month: string;
  mode: "dry-run" | "execute";
  /** Required for execute, exactly as the CLI requires it. */
  approval?: string | null;
  /** One synthesis review of the finished map. It cannot add queries or pages. */
  ai?: boolean;
  /** Rebuild a map that already exists for this month. */
  refresh?: boolean;
  /** Propose a new job map instead of reusing the stored one. */
  refreshJobMap?: boolean;
  /** Where the markdown report is written. Omit for no file. */
  reports?: { write: (name: string, body: string) => Promise<void> | void } | null;
  /** Progress lines, for a CLI only. */
  onNote?: (message: string) => void;
};

export type TopicMapStageResult = {
  status: "completed" | "skipped" | "failed";
  /** Set when a stored, completed map was reused. */
  runId: string | null;
  map: TopicMap | null;
  detail: string;
};

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
    if (Array.isArray(inner)) return inner.filter((entry): entry is string => typeof entry === "string").join("; ") || null;
  }
  return null;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  const text = asString(value);
  if (!text) return [];
  return text.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);
}

export async function runTopicMapStage(
  db: TopicMapStageDb,
  input: TopicMapStageInput
): Promise<TopicMapStageResult> {
  const note = input.onNote ?? (() => {});
  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { id: true, domain: true, projectId: true, retiredAt: true },
  });
  if (!site) return { status: "failed", runId: null, map: null, detail: `site ${input.siteId} not found` };
  if (site.retiredAt) return { status: "failed", runId: null, map: null, detail: `site ${site.domain} is retired` };
  if (!site.projectId) {
    return { status: "failed", runId: null, map: null, detail: `site ${site.domain} is not attached to a project` };
  }

  const { month } = input;
  const key = topicMapKey(site.id, month);
  const existing = await db.researchRun.findFirst({ where: { siteId: site.id, idempotencyKey: key } });

  // A completed map is reused unless the caller asks to rebuild it. This is the
  // idempotency the CLI always had; the pipeline relies on it rather than
  // keeping a second record of "already done".
  //
  // The reuse is stated with its staleness: a map older than the latest
  // completed bundle is returned as `skipped (stale)` rather than as a plain
  // reuse, because rebuilding it costs a model call and that is the caller's
  // decision. What must not happen is the stale map looking current.
  //
  // Only for `execute`: a dry run writes nothing, so reusing an existing run
  // would mean it never shows the map it is being asked to preview.
  if (input.mode === "execute" && existing?.status === "COMPLETED" && !input.refresh) {
    const stored = (existing.report as { map?: TopicMap } | null)?.map ?? null;
    const staleness = await readTopicMapStaleness(db, { siteId: site.id, month });
    const state =
      staleness?.state ?? mapStaleness({ mapBundleRunId: stored?.inputs?.bundleRunId ?? null, latestBundleRunId: null });
    return {
      status: "skipped",
      runId: existing.id,
      map: stored,
      detail:
        state === "current"
          ? `existing topic map ${existing.id} is current against its bundle and returned without rebuilding (pass refresh to rebuild)`
          : `existing topic map ${existing.id} is ${state}: ${staleness?.detail ?? "its inputs cannot be confirmed"}; pass refresh to rebuild`,
    };
  }

  // The job map is the only semantic pass. The taxonomy is a projection of it:
  // one job, one topic, owner = job page.
  let jobMap: JobMap | null = await loadJobMap(db, site.id);
  const rawData = await loadTopicMapData(db, site.id, month);
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
        name: rawData.fields.businessName
          ? String((rawData.fields.businessName as { value?: unknown }).value ?? "") || null
          : null,
        services: asStringList(rawData.fields.services),
        location: asString(rawData.fields.location),
        serviceArea: asStringList(rawData.fields.serviceArea),
        audience: rawData.context.audience ?? asString(rawData.fields.audienceMotivations),
        audienceMotivations: asStringList(rawData.fields.audienceMotivations),
        differentiators: asStringList(rawData.fields.differentiators),
        concerns: asStringList(rawData.fields.concerns),
      },
      offers: rawData.marketScope.offers,
      pages: [...rawData.pages]
        .sort((a, b) => b.wordCount - a.wordCount)
        .map((page) => ({ path: page.path, title: page.title, h1: page.h1, wordCount: page.wordCount })),
      queries: rawData.queries.map((query) => ({ query: query.query, impressions: query.impressions, volume: query.volume })),
      previous: jobMap,
    });
    if (!proposed.jobMap) {
      return {
        status: "failed",
        runId: null,
        map: null,
        detail: `could not propose a job map for ${site.domain}: ${proposed.error ?? "unknown error"}`,
      };
    }
    jobMap = proposed.jobMap;
    for (const row of proposed.rejected) note(`job map row skipped: ${row.title} — ${row.reason}`);
    if (proposed.unassigned.length > 0) {
      note(
        `job map left ${proposed.unassigned.length} tranche queries unassigned: ${proposed.unassigned
          .slice(0, 10)
          .join(", ")}${proposed.unassigned.length > 10 ? ", …" : ""}`
      );
    }
    if (input.reports) {
      await input.reports.write(`${site.domain}-job-map-${month}.json`, JSON.stringify(jobMap, null, 2));
    }
    if (input.mode === "execute") await saveJobMap(db, site.id, jobMap);
    note(
      `job map: ${jobMap.jobs.length} jobs, ${jobMap.counts.assigned}/${jobMap.counts.sent} tranche queries assigned, ` +
        `${jobMap.counts.judged}/${jobMap.counts.queries} judged so far (${jobMap.counts.carried} carried), ` +
        `${jobMap.counts.deferred} unjudged`
    );
  }
  if (!jobMap) return { status: "failed", runId: null, map: null, detail: `no job map for ${site.domain}` };

  const taxonomy = projectTopicTaxonomy(jobMap);
  if (input.reports) {
    await input.reports.write(`${site.domain}-taxonomy-${month}.json`, JSON.stringify(taxonomy, null, 2));
  }
  if (input.mode === "execute") await saveTopicTaxonomy(db, site.id, taxonomy);

  const data = await loadTopicMapData(db, site.id, month, taxonomy);
  const map = buildTopicMap(data, taxonomy.topics, undefined, jobMap);

  if (input.mode === "dry-run") {
    if (input.reports) await input.reports.write(`${site.domain}-topic-map-${month}.md`, renderMap(map));
    return { status: "completed", runId: existing?.id ?? null, map, detail: `dry run: ${describeMap(map)}` };
  }

  const approval = input.approval?.trim();
  if (!approval) return { status: "failed", runId: null, map, detail: "execute requires an approval reference" };

  if (input.ai) {
    map.ai = await synthesizeTopicMap(map, map.business);
    if (!map.ai.available) note(`AI review unavailable: ${map.ai.error ?? "unknown error"}`);
  }

  const stored = await storeTopicMap(db, map);
  const checksum = topicMapChecksum(map);
  const report = {
    version: 1,
    map,
    checksum,
    stored,
    approvalReference: approval,
    ai: map.ai,
    note: map.ai.available
      ? "One context-synthesis review was run. The provider does not report token usage to this client, so no AI cost is recorded against the DataForSEO budget."
      : "No AI review was run; the deterministic map is stored as-is.",
  };
  const runData = {
    siteId: site.id,
    projectId: site.projectId,
    kind: "SEO" as const,
    trigger: "MANUAL" as const,
    status: "COMPLETED" as const,
    title: `Topic map — ${month}`,
    brief: { month, taxonomy: "stored-v1", ai: Boolean(input.ai), approvalReference: approval } as never,
    topics: map.clusters.map((cluster) => cluster.name) as never,
    recencyDays: 31,
    promptVersion: "topic-map-v1",
    idempotencyKey: key,
    requestedBy: "research-pipeline",
    startedAt: new Date(),
    completedAt: new Date(),
    report: report as never,
    sourceCount: map.counts.news,
    findingCount: 0,
    actionCount: 0,
    costMicros: 0,
  };
  const runId = existing
    ? (await db.researchRun.update({ where: { id: existing.id }, data: runData, select: { id: true } })).id
    : (await db.researchRun.create({ data: runData, select: { id: true } })).id;

  if (input.reports) await input.reports.write(`${site.domain}-topic-map-${month}.md`, renderMap(map));

  return {
    status: "completed",
    runId,
    map,
    detail: `${describeMap(map)}; stored ${stored.created} created, ${stored.updated} updated, ${stored.memberships} memberships`,
  };
}

function describeMap(map: TopicMap): string {
  return (
    `${map.clusters.length} clusters, ${map.counts.queries} queries ` +
    `(${map.counts.clusteredQueries} clustered, ${map.counts.unmappedQueries} unmapped)`
  );
}

function renderMap(map: TopicMap): string {
  // The report format belongs to the map, not to the stage.
  return renderTopicMapMarkdown(map);
}
