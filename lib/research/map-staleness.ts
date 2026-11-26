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
  /**
   * The latest bundle that stored anything for the same site and month.
   *
   * `PARTIAL` and `COMPLETED` both count. A partial bundle is not an absent one: it can
   * hold the keyword metrics, SERP snapshots and competitor ranks that were paid for,
   * with one section short. Measured 2026-11-25 on alaguillotine, a partial bundle held
   * 187 keyword metrics, 10 SERP snapshots and 134 competitor ranks for $0.27 while two
   * AI Overview queries failed at the provider. Treating it as no bundle told the owner
   * their map had no paid evidence at all, which was false.
   */
  latestBundleRunId: string | null;
  /** Whether that bundle completed every section. `PARTIAL` means some evidence is missing. */
  latestBundleStatus?: "COMPLETED" | "PARTIAL" | null;
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

/**
 * How much of a bundle actually landed, when it is not complete.
 *
 * "Partial" covers everything from one failed question to most of the run, and those are
 * different facts. Measured 2026-11-25 on alaguillotine: a PARTIAL bundle stored 187 keyword
 * metrics, 10 SERP snapshots and 134 competitor ranks, with one section short — 8 of 12 AI
 * Overview questions answered. Calling that and a half-empty run the same thing hides the
 * only number an owner needs.
 *
 * The share is computed from the section plan, not from impressions or rows, because a
 * section is the unit that was bought: a section either collected or it did not.
 */
export type BundleCompleteness = {
  /** Sections that stored evidence. */
  stored: number;
  /** Sections that were planned. */
  planned: number;
  /** 0–1. 1 means every planned section stored something. */
  share: number;
  /** Sections that stored nothing, or only part of what they selected. */
  short: string[];
};

/**
 * Read how complete a bundle was from its own report.
 *
 * Returns null when the report has no section list (a run written before sections were
 * recorded), so an unknown completeness is never presented as a good or bad one.
 */
export function readBundleCompleteness(report: unknown): BundleCompleteness | null {
  const sections = (report as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const rows = sections as Array<{ name?: string; status?: string; partial?: boolean }>;
  const stored = rows.filter((row) => row.status === "stored" || row.status === "reused").length;
  const short = rows
    .filter((row) => (row.status !== "stored" && row.status !== "reused") || row.partial === true)
    .map((row) => String(row.name ?? "unknown"));
  return { stored, planned: rows.length, share: stored / rows.length, short };
}

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
  /**
   * Whether the bundle the map is judged against completed every section.
   *
   * `PARTIAL` is surfaced so the board can say "some evidence is missing" instead of
   * either claiming the map is fully grounded or claiming there is no evidence at all.
   */
  latestBundleStatus: "COMPLETED" | "PARTIAL" | null;
  /**
   * How much of the bundle landed, when the report says. Null when it does not say.
   *
   * A partial bundle missing one of eight sections is a different problem from one missing
   * five, and only this tells them apart.
   */
  latestBundleCompleteness: BundleCompleteness | null;
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

  /**
   * The newest bundle that produced evidence — `PARTIAL` included.
   *
   * The map's own record is the strongest signal available, and it names the run it read.
   * Filtering to `COMPLETED` here meant a partial bundle was invisible to this check even
   * when the map had literally recorded its id, and the board then reported "no completed
   * bundle exists" about evidence the map was built from.
   */
  const latestBundle = await db.researchRun.findFirst({
    where: {
      siteId: input.siteId,
      idempotencyKey: bundleKey(input.siteId, input.month),
      status: { in: ["COMPLETED", "PARTIAL"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, completedAt: true, status: true, report: true },
  });

  const completeness = readBundleCompleteness(latestBundle?.report);
  const state = mapStaleness({
    mapBundleRunId,
    latestBundleRunId: latestBundle?.id ?? null,
    mapCreatedAt: topicMapRun.createdAt,
    latestBundleCompletedAt: latestBundle?.completedAt ?? null,
    latestBundleStatus: (latestBundle?.status as "COMPLETED" | "PARTIAL" | undefined) ?? null,
  });
  return {
    state,
    topicMapRunId: topicMapRun.id,
    mapBundleRunId,
    latestBundleStatus: (latestBundle?.status as "COMPLETED" | "PARTIAL" | undefined) ?? null,
    latestBundleCompleteness: completeness,
    latestBundleRunId: latestBundle?.id ?? null,
    latestBundleCompletedAt: latestBundle?.completedAt?.toISOString() ?? null,
    detail: describe(state, mapBundleRunId, latestBundle?.id ?? null, (latestBundle?.status as "COMPLETED" | "PARTIAL" | undefined) ?? null, completeness),
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

function describe(
  state: MapStaleness,
  mapBundleRunId: string | null,
  latestBundleRunId: string | null,
  latestBundleStatus: "COMPLETED" | "PARTIAL" | null = null,
  completeness: BundleCompleteness | null = null
): string {
  switch (state) {
    case "current":
      return "";
    case "no-bundle":
      // Deliberately does not say "no bundle exists" as if it were an accident. A bundle can
      // be absent because none was attempted, or because it was refused for a reason the
      // owner can act on — a stated market is missing. Saying only the first makes the
      // second look like a bug in the product.
      return "no completed bundle exists for this month, so the map was built without paid evidence; its clusters describe only what Search Console and the crawl already knew. If a bundle was attempted and refused, the reason is in the run log: a market-scoped bundle needs a stated audience market, and a site whose measured audience is too scattered to name one is refused rather than guessed";
    case "stale":
    default: {
      // A stale map against a PARTIAL bundle is still worth rebuilding — the evidence it
      // has was paid for — but the reader should know the new bundle is short a section,
      // so a cluster with nothing attached is not read as proof of no demand.
      // Say how short it is, not just that it is short. One missing section and a
      // half-empty run are different facts, and the owner acts differently on each.
      const partial =
        latestBundleStatus !== "PARTIAL"
          ? ""
          : completeness
            ? ` (that bundle is partial: ${completeness.stored} of ${completeness.planned} sections collected${completeness.short.length ? `; short on ${completeness.short.join(", ")}` : ""})`
            : " (that bundle is partial: not every section was collected)";
      return mapBundleRunId
        ? `built from bundle ${mapBundleRunId}, but ${latestBundleRunId} is the latest one${partial}; rebuild the map to include it`
        : `built before ${latestBundleRunId} finished${partial}; rebuild the map to include it`;
    }
  }
}
