import type { PrismaClient } from "@prisma/client";

import { bundleKey } from "@/lib/research/monthly-bundle";
import type { TopicMap } from "@/lib/research/topic-map";

/**
 * Whether a topic map still reflects the evidence it was built from.
 *
 * The defect this replaces: a map recorded nothing about which bundle it read.
 * When the bundle arrived late or was re-run, the map kept its old contents with
 * no marker, so an empty cluster was indistinguishable from a cluster whose
 * demand genuinely has not been measured. Measured 2026-11-25, astridrincon's
 * map was built two hours before its bundle and casamigo's 37 minutes before,
 * and both boards looked like findings.
 *
 * Three states:
 *
 *  - `current`    — the map consumed the latest completed bundle, either because
 *                   it recorded that run or because it finished after it.
 *  - `stale`      — a completed bundle exists that the map may not have read.
 *  - `no-bundle`  — there is no completed bundle at all. That is a different
 *                   statement from "this site has no demand" and must read as
 *                   one, which is why it is not folded into `current`.
 *
 * The state is derived every time it is asked for. There is no stored flag that
 * can go out of date.
 */

export type MapStaleness = "current" | "stale" | "no-bundle";

export type StalenessInput = {
  /** The bundle run the map consumed, as recorded on the map. Null on maps written before this contract. */
  mapBundleRunId: string | null;
  /** The latest completed bundle for the same site and month. */
  latestBundleRunId: string | null;
  /**
   * When the map run was created. Used as evidence only when no bundle id was
   * recorded.
   *
   * `createdAt` and not `completedAt`: a run row can be updated later (a rebuild,
   * a refresh), which moves `completedAt` forward and would make an old map look
   * as though it had seen a bundle it never read. Measured: casamigo's map was
   * created 11-06 19:44, before its bundle finished at 11-07 00:31, but its
   * `completedAt` reads 11-08 18:39. `createdAt` is the only timestamp on a run
   * that cannot move.
   */
  mapCreatedAt?: Date | null;
  /** When the latest completed bundle finished. */
  latestBundleCompletedAt?: Date | null;
};

export function mapStaleness(input: StalenessInput): MapStaleness {
  if (!input.latestBundleRunId) return "no-bundle";
  if (input.mapBundleRunId) return input.mapBundleRunId === input.latestBundleRunId ? "current" : "stale";

  // Legacy map: no recorded input, so the id cannot prove anything. Time can. A
  // map that finished after the newest bundle cannot have missed it, and calling
  // that stale would put a rebuild banner on a site whose map is correct.
  const mapAt = input.mapCreatedAt?.getTime() ?? null;
  const bundleAt = input.latestBundleCompletedAt?.getTime() ?? null;
  if (mapAt != null && bundleAt != null) return mapAt >= bundleAt ? "current" : "stale";

  // Neither the id nor the time proves freshness. Unknown is reported as stale,
  // never as current: the cost is a rebuild prompt, the alternative is an empty
  // board presented as a finding.
  return "stale";
}

export type TopicMapStaleness = {
  state: MapStaleness;
  /** The map's run id, so a caller can act on the exact run it is asking about. */
  topicMapRunId: string;
  mapBundleRunId: string | null;
  latestBundleRunId: string | null;
  latestBundleCompletedAt: string | null;
  /** One sentence a reader can act on. Empty when the map is current. */
  detail: string;
};

/**
 * Read the staleness of a site's stored map for one month.
 *
 * Returns null when there is no map at all: "no map" is the pipeline gate's
 * business, and reporting it as a staleness state would conflate a missing
 * stage with an out-of-date one.
 */
export async function readTopicMapStaleness(
  db: PrismaClient,
  input: { siteId: string; month: string }
): Promise<TopicMapStaleness | null> {
  const topicMapRun = await db.researchRun.findFirst({
    where: { siteId: input.siteId, idempotencyKey: `topic-map:${input.siteId}:${input.month}` },
    orderBy: { createdAt: "desc" },
    select: { id: true, report: true, createdAt: true },
  });
  if (!topicMapRun) return null;

  const map = (topicMapRun.report as { map?: TopicMap } | null)?.map ?? null;
  const mapBundleRunId = map?.inputs?.bundleRunId ?? null;

  const latestBundle = await db.researchRun.findFirst({
    where: {
      siteId: input.siteId,
      idempotencyKey: bundleKey(input.siteId, input.month),
      status: "COMPLETED",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, completedAt: true },
  });

  const state = mapStaleness({
    mapBundleRunId,
    latestBundleRunId: latestBundle?.id ?? null,
    mapCreatedAt: topicMapRun.createdAt,
    latestBundleCompletedAt: latestBundle?.completedAt ?? null,
  });
  return {
    state,
    topicMapRunId: topicMapRun.id,
    mapBundleRunId,
    latestBundleRunId: latestBundle?.id ?? null,
    latestBundleCompletedAt: latestBundle?.completedAt?.toISOString() ?? null,
    detail: describe(state, mapBundleRunId, latestBundle?.id ?? null),
  };
}

/**
 * The staleness of the site's most recent stored map, whatever month it covers.
 *
 * The board asks "was the map this board came from built against the evidence
 * it should have?" without knowing the month, so this resolves the month from
 * the newest map run rather than assuming the current one: a board can be from a
 * month that has already rolled over.
 */
export async function readLatestTopicMapStaleness(
  db: PrismaClient,
  siteId: string
): Promise<(TopicMapStaleness & { month: string }) | null> {
  const latest = await db.researchRun.findFirst({
    where: { siteId, idempotencyKey: { startsWith: `topic-map:${siteId}:` } },
    orderBy: { createdAt: "desc" },
    select: { idempotencyKey: true, brief: true },
  });
  const month =
    (latest?.brief as { month?: string } | null)?.month ??
    latest?.idempotencyKey?.slice(`topic-map:${siteId}:`.length) ??
    null;
  if (!month) return null;
  const staleness = await readTopicMapStaleness(db, { siteId, month });
  return staleness ? { ...staleness, month } : null;
}

function describe(state: MapStaleness, mapBundleRunId: string | null, latestBundleRunId: string | null): string {
  switch (state) {
    case "current":
      return "";
    case "no-bundle":
      return "no completed bundle exists for this month, so the map was built without paid evidence; its clusters describe only what Search Console and the crawl already knew";
    case "stale":
    default:
      return mapBundleRunId
        ? `built from bundle ${mapBundleRunId}, but ${latestBundleRunId} is the latest completed one; rebuild the map to include it`
        : `built before ${latestBundleRunId} completed; rebuild the map to include it`;
  }
}
