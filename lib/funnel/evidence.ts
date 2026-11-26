import { createHash } from "node:crypto";

import type { PrismaClient, Prisma } from "@prisma/client";

import type { EvidenceRecord, EvidenceRecordKind } from "@prisma/client";

import { EVIDENCE_KINDS, EVIDENCE_REGISTRY } from "@/lib/funnel/evidence-registry";

export { EVIDENCE_KINDS, EVIDENCE_REGISTRY };
export type { EvidenceKindSpec, EvidenceWindow } from "@/lib/funnel/evidence-registry";

/**
 * Evidence store for the funnel spine (docs/seo-funnel-spine-plan.md §4).
 * One envelope for both evidence legs (business and search).
 *
 * Invariants enforced here:
 *  - no evidence without provenance: producer + observedAt always; a paid
 *    provider response (with cost) for provider-collected kinds;
 *  - provider-sourced and first-party metrics never share a label: metric
 *    keys must be namespaced by their declared source;
 *  - every metric declares its unit;
 *  - supersede, never delete: superseding a record writes the replacement
 *    and points the old row at it.
 */

export type MetricSource = "provider" | "first_party" | "derived";

export type MetricValue = {
  value: number | null;
  unit: string;
  source: MetricSource;
};

/**
 * Dimensions are JSON scalars or arrays of scalars. Arrays are allowed because
 * some observations are inherently multi-valued (a SERP's top URLs, a page's
 * internal link targets) and flattening them into JSON strings would lose type.
 */
export type EvidenceDimensionValue = string | number | boolean | null | string[] | number[];
export type EvidenceDimensions = Record<string, EvidenceDimensionValue>;

export type EvidenceRecordPayload = {
  projectId: string;
  siteId?: string | null;
  kind: EvidenceRecordKind;
  observedAt: Date;
  validFrom?: Date | null;
  validTo?: Date | null;
  producer: string;
  rawResponseId?: string | null;
  dimensions: EvidenceDimensions;
  metrics: Record<string, MetricValue>;
};

/** Kinds whose metrics may come from a paid provider (see the rule below). */
export const PROVIDER_COLLECTED_KINDS: ReadonlySet<string> = new Set([
  "keyword_rank",
  "keyword_metrics",
  "serp_snapshot",
  "serp_features",
  "competitor_rank",
  "backlink_profile",
  "share_of_voice",
  "keyword_universe_membership",
  "ai_visibility_observation",
]);

/**
 * Provenance rule: evidence is "paid" when any stored metric declares
 * `source: "provider"`. Paid evidence must point at the raw response and its
 * recorded cost. The same kind can be collected first-party (GSC ranks, our
 * crawler) and then needs no raw provider payload — so the rule is driven by
 * the declared metric source, not by the kind alone.
 */
export function requiresPaidProvenance(metrics: Record<string, MetricValue>): boolean {
  return Object.values(metrics).some((metric) => metric.source === "provider");
}



export function computeObservationHash(payload: EvidenceRecordPayload): string {
  const canonical = JSON.stringify({
    projectId: payload.projectId,
    kind: payload.kind,
    observedAt: payload.observedAt.toISOString(),
    dimensions: sorted(payload.dimensions),
    metrics: sortedMetrics(payload.metrics),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sorted(input: EvidenceDimensions): EvidenceDimensions {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function sortedMetrics(metrics: Record<string, MetricValue>): Record<string, MetricValue> {
  return Object.fromEntries(Object.entries(metrics).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function validateMetricLabel(label: string, metric: MetricValue): void {
  if (!label.startsWith(`${metric.source}:`)) {
    throw new Error(
      `metric label "${label}" must be namespaced by its declared source "${metric.source}" (provider and first-party metrics never share a label)`
    );
  }
  if (typeof metric.unit !== "string" || metric.unit.trim() === "") {
    throw new Error(`metric "${label}" must declare a unit`);
  }
}

/**
 * Reject a write whose shape its kind never declared.
 *
 * This is the whole point of the registry: before it, a writer could store a
 * dimension or a metric label that no reader expects, or omit one a reader needs,
 * and the build stayed green. The three rejections below each have a test.
 */
export function validateAgainstRegistry(input: EvidenceRecordPayload): void {
  const spec = EVIDENCE_REGISTRY[input.kind];
  if (!spec) {
    throw new Error(`evidence kind "${String(input.kind)}" is not declared in EVIDENCE_REGISTRY`);
  }

  // 1. Every dimension a reader needs must be present and non-empty.
  for (const key of spec.dimensions.required) {
    const value = input.dimensions[key];
    const present = value != null && !(typeof value === "string" && value.trim() === "");
    if (!present) {
      throw new Error(
        `evidence kind "${input.kind}" requires dimension "${key}" (declared in EVIDENCE_REGISTRY.dimensions.required)`
      );
    }
  }

  // 2. A dimension outside both lists is a typo nobody will ever read.
  const declared = new Set([...spec.dimensions.required, ...spec.dimensions.optional]);
  for (const key of Object.keys(input.dimensions)) {
    if (!declared.has(key)) {
      throw new Error(
        `evidence kind "${input.kind}" stores undeclared dimension "${key}" (add it to EVIDENCE_REGISTRY if it is real)`
      );
    }
  }

  // 3. A metric label outside the list is a number no reader asked for.
  const allowed = new Set(spec.metrics);
  for (const label of Object.keys(input.metrics)) {
    if (!allowed.has(label)) {
      throw new Error(
        `evidence kind "${input.kind}" stores undeclared metric label "${label}" (declared: ${spec.metrics.join(", ") || "none"})`
      );
    }
  }
}


/** Every row at the newest observed instant. The one `sampled_point` rule. */
export function latestSample<T extends { observedAt: Date }>(rows: T[]): T[] {
  if (rows.length === 0) return [];
  const latest = rows.reduce((max, row) => (row.observedAt > max ? row.observedAt : max), rows[0].observedAt);
  return rows.filter((row) => row.observedAt.getTime() === latest.getTime());
}

/**
 * The one place that decides which evidence row is "current".
 *
 * Before CMP-011 every reader re-implemented this: 44 `supersededById: null`
 * filters across 22 files, and two different guesses at "the latest window" that
 * disagreed. `detectors.ts` called `selectCurrentEvidence`, `previousWindowEvidence`
 * took the second-newest `windowEnd` — which for a daily rolling 28-day sync is
 * yesterday's *current* window, not the `previous`-role one — and the two spans
 * shared 27 of 28 days. That is CMP-010: 291 pairs compared, 51 % identical, O11
 * fired once; against the real `previous` window it fires 43 times.
 *
 * It honours the kind's declared window:
 *  - `rolling_window` reads by `windowRole`. The current window is the one a
 *    writer labelled `current`; the comparison window is the one labelled
 *    `previous`. A kind with no role falls back to the newest `windowEnd`, because
 *    un-migrated projects still only store one window.
 *  - `single_point` keeps the latest row per identity.
 *  - `sampled_point` keeps every row at the latest observed sample.
 *
 * `asOf` bounds the rows considered, so a replay reads the store as it was.
 */
export type CurrentEvidenceOptions = {
  projectId: string;
  kinds?: EvidenceRecordKind[];
  siteId?: string | null;
  /** Only rows observed at or before this instant. */
  asOf?: Date;
};

type CurrentEvidenceRow = Pick<EvidenceRecord, "id" | "kind" | "observedAt" | "dimensions">;

/** Identity of a single-point row: two observations of the same thing collide. */
function identityOf(row: CurrentEvidenceRow): string {
  const dimensions = (row.dimensions ?? {}) as Record<string, unknown>;
  return `${row.kind}|${["url", "query", "question", "field", "findingId", "scope"]
    .map((key) => (typeof dimensions[key] === "string" ? `${key}=${dimensions[key]}` : ""))
    .filter(Boolean)
    .join("|")}`;
}

/**
 * Which rank wins when a row carries both a provider and a first-party position.
 *
 * One rule, declared, instead of the four identical
 * `provider:position ?? first_party:position` expressions that were spread across
 * the detectors. First-party wins: it is the site's own measured Search Console
 * rank, while a provider rank is a single sample. The provider is the fallback,
 * not the truth.
 */
export const RANK_PRECEDENCE: readonly string[] = ["first_party:position", "provider:position"];

export function rankOf(metrics: unknown): number | null {
  if (metrics == null || typeof metrics !== "object") return null;
  const byLabel = metrics as Record<string, { value?: unknown } | undefined>;
  for (const label of RANK_PRECEDENCE) {
    const value = byLabel[label]?.value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * CMP-010: how many days two rank windows must differ by before comparing them.
 *
 * Two 28-day windows that share most of their data are not a comparison: a position that
 * "fell 3 places" between two windows overlapping by 27 of 28 days is the same average
 * moving by less than its own noise. The floor is a named constant so the rule is checkable
 * rather than implied by which rows happened to be newest.
 */
export const MIN_COMPARISON_GAP_DAYS = 21;

/**
 * The two rank windows to compare, and everything a reader needs to check the claim.
 *
 * `previousWindowEvidence` answers "which rows are the previous window"; this answers "which
 * two periods, how much do they overlap, and if there is no honest comparison, why not". The
 * detectors need the second: a project with one projected window must report O11 as disabled
 * with a reason, not as an empty board.
 */
export type RankWindowComparison<T extends CurrentEvidenceRow> = {
  current: T[];
  previous: T[];
  /** The ISO date each window ends on, so the summary can print both. */
  currentWindowEnd: string | null;
  previousWindowEnd: string | null;
  /** The declared window length, from the rows themselves. */
  windowDays: number | null;
  /**
   * Days the two windows share. `0` is a clean comparison; `null` means it could not be
   * determined, which is treated as not comparable rather than as zero.
   */
  overlapDays: number | null;
  /** Days between the previous window's end and the current window's start. */
  gapDays: number | null;
  /**
   * Rows with no `windowRole`. They describe a period nobody labelled, so they are counted
   * and excluded, never used as a comparison.
   */
  legacyRows: number;
  /** Why there is no comparison, or null when there is one. */
  reason: string | null;
};

const windowEndOf = (row: CurrentEvidenceRow): string | null => {
  const value = ((row.dimensions ?? {}) as { windowEnd?: unknown }).windowEnd;
  return typeof value === "string" ? value : null;
};

const windowDaysOf = (row: CurrentEvidenceRow): number | null => {
  const value = ((row.dimensions ?? {}) as { windowDays?: unknown }).windowDays;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
};

const newestWindow = (list: CurrentEvidenceRow[]): string | null => {
  const ends = list.map(windowEndOf).filter((value): value is string => value !== null).sort();
  return ends.length > 0 ? ends[ends.length - 1] : null;
};

const dayDifference = (later: string, earlier: string): number | null => {
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86_400_000);
};

/**
 * Select the pair of rank windows a movement detector may compare.
 *
 * The rule, in order:
 *
 *  1. **A window is identified by its `windowEnd`, not by array position.** A daily sync
 *     re-projects a rolling window every day, so the second-newest `windowEnd` is
 *     yesterday's `current` window, not the `previous` one. Measured on Susi: 51% of pairs
 *     differed by exactly 0 and O11 fired once.
 *  2. **A row without a `windowRole` is not a comparison.** 281 such rows exist on Susi;
 *     they are counted and excluded.
 *  3. **The pair must be far enough apart.** The gap between the previous window's end and
 *     the current window's start must be at least `MIN_COMPARISON_GAP_DAYS`; otherwise there
 *     is no honest comparison and the reason says so.
 */
export function compareRankWindows<T extends CurrentEvidenceRow>(rows: T[]): RankWindowComparison<T> {
  const rankRows = rows.filter((row) => row.kind === "keyword_rank") as T[];
  const roleOf = (row: T) => ((row.dimensions ?? {}) as { windowRole?: unknown }).windowRole;

  const declaredCurrent = rankRows.filter((row) => roleOf(row) === "current");
  const declaredPrevious = rankRows.filter((row) => roleOf(row) === "previous");
  const legacyRows = rankRows.filter((row) => roleOf(row) == null).length;

  const empty = (reason: string): RankWindowComparison<T> => ({
    current: [],
    previous: [],
    currentWindowEnd: null,
    previousWindowEnd: null,
    windowDays: null,
    overlapDays: null,
    gapDays: null,
    legacyRows,
    reason,
  });

  if (declaredCurrent.length === 0 || declaredPrevious.length === 0) {
    // No comparison is possible, but the CURRENT window must still be selectable: current
    // evidence selection calls this, and returning nothing here would blank a site whose
    // first projection has just landed. The reason distinguishes the two cases because the
    // fix differs — "no history yet" clears itself next month, "no current rows" does not.
    const pool = declaredCurrent.length > 0 ? declaredCurrent : rankRows;
    const latest = newestWindow(pool);
    // No `windowEnd` anywhere is the documented legacy shape: nothing says which period a row
    // describes, so every row is kept. An un-migrated project still analyses.
    const current = latest ? pool.filter((row) => windowEndOf(row) === latest) : pool;
    return {
      current,
      previous: [],
      currentWindowEnd: latest,
      previousWindowEnd: null,
      windowDays: rankRows.length > 0 ? windowDaysOf(rankRows[0]) : null,
      overlapDays: null,
      gapDays: null,
      legacyRows,
      reason:
        declaredPrevious.length === 0
          ? "Only one rank window has been projected, so there is nothing to compare it against yet."
          : "No current rank window has been projected, so there is nothing to compare against.",
    };
  }

  const currentAt = newestWindow(declaredCurrent);
  const current = currentAt ? declaredCurrent.filter((row) => windowEndOf(row) === currentAt) : [];
  if (current.length === 0 || !currentAt) {
    return empty("The current window has no `windowEnd`, so its period is unknown and it cannot be compared.");
  }

  const windowDays = windowDaysOf(current[0]);

  // The previous window must END before the current window STARTS. The start is derived from
  // the end and the declared length, because production rows carry no `windowStart`: measured
  // 2026-11-24, `keyword_rank` dimension keys are url/query/scope/segments/windowEnd/
  // windowDays/windowRole/observations, with no start. Deriving it is arithmetic on two
  // stored facts, not a guess.
  const eligible = declaredPrevious.filter((row) => {
    const end = windowEndOf(row);
    if (end == null) return false;
    if (windowDays == null) return true;
    const gap = dayDifference(currentAt, end);
    // The previous window's last day must be at least a full window plus the floor earlier:
    // a 28-day window ending 28 days before this one starts has a gap of 28.
    return gap != null && gap >= windowDays;
  });
  const previousAt = newestWindow(eligible);
  const previous = previousAt ? eligible.filter((row) => windowEndOf(row) === previousAt) : [];

  if (!previousAt || previous.length === 0) {
    const newestPrevious = newestWindow(declaredPrevious);
    const gap = newestPrevious ? dayDifference(currentAt, newestPrevious) : null;
    return {
      current,
      previous: [],
      currentWindowEnd: currentAt,
      previousWindowEnd: newestPrevious,
      windowDays,
      overlapDays: gap != null && windowDays != null ? Math.max(0, windowDays - gap) : null,
      gapDays: gap,
      legacyRows,
      reason:
        gap != null && windowDays != null
          ? `The only previous window (ending ${newestPrevious!.slice(0, 10)}) is ${gap} days before this one, so the two overlap by ${Math.max(0, windowDays - gap)} days — under the ${MIN_COMPARISON_GAP_DAYS}-day floor. Rank movement is not measured.`
          : "No previous window ends before this one starts, so the two would overlap and rank movement is not measured.",
    };
  }

  const gapDays = dayDifference(currentAt, previousAt);
  return {
    current,
    previous,
    currentWindowEnd: currentAt,
    previousWindowEnd: previousAt,
    windowDays,
    overlapDays: gapDays != null && windowDays != null ? Math.max(0, windowDays - gapDays) : null,
    gapDays,
    legacyRows,
    reason: null,
  };
}

export function partitionByWindowRole<T extends CurrentEvidenceRow>(
  rows: T[]
): { current: T[]; previous: T[]; pairs: Map<string, T> } {
  const { current, previous } = compareRankWindows(rows);
  return { current, previous, pairs: new Map() };
}

/**
 * The latest observation per identity, for detectors that ask "what is true now".
 *
 * ## Why this is not `compareRankWindows`
 *
 * `compareRankWindows` answers O11's question — "give me two aligned windows to diff" — and
 * to do that it narrows to a single `windowEnd`. Search Console does not project every query
 * on the same day, so that single date is a subset: measured 2026-11-25 on casamigo, 9 distinct
 * queries carried a `current` role across 5 different `windowEnd`s, and taking the newest kept
 * 4 rows. With 4 rows, **no query had two competing URLs**, so the cannibalisation detector
 * could never fire on real data — the analysis looked absent rather than starved.
 *
 * Detectors that answer "what is the current state of each query/page" need the other rule:
 * the newest period per query and page, keeping every row inside it. That is arithmetic on a
 * stored date, not a judgement about periods.
 */
export function latestWindowPerIdentity<T extends CurrentEvidenceRow>(rows: T[]): T[] {
  /**
   * The newest period each thing was observed in — one period, but every row inside it.
   *
   * This is a *window* rule, not a dedup rule, and the difference is the whole point. A query
   * projected under several segments is stored as several rows sharing one identity; they are
   * one observation expressed several ways, and a consumer that has to choose between them
   * (O11 keeps the projection with the most impressions) can only choose if it sees all of
   * them. Collapsing to a single row here would pick arbitrarily and hand the detector a
   * decision already made. Measured 2026-11-24 on Susi: `akumal real estate` is four rows.
   *
   * What is dropped is the *older periods*: a row describing September is superseded by one
   * describing October for the same query and page.
   */
  const newestEnd = new Map<string, string | null>();
  for (const row of rows) {
    const key = identityOf(row);
    const end = windowEndOf(row);
    const held = newestEnd.get(key);
    if (held === undefined) newestEnd.set(key, end);
    else if (end != null && (held == null || end > held)) newestEnd.set(key, end);
  }
  return rows.filter((row) => {
    const end = newestEnd.get(identityOf(row)) ?? null;
    // No `windowEnd` anywhere for this identity is the documented legacy shape: nothing says
    // which period a row describes, so every row is kept and an un-migrated project analyses.
    if (end == null) return true;
    return windowEndOf(row) === end;
  });
}

export async function currentEvidence(db: EvidenceDb, options: CurrentEvidenceOptions): Promise<EvidenceRecord[]> {
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: options.projectId,
      siteId: options.siteId ?? undefined,
      kind: options.kinds ? { in: options.kinds } : undefined,
      supersededById: null,
      observedAt: options.asOf ? { lte: options.asOf } : undefined,
    },
  });

  const byKind = new Map<string, EvidenceRecord[]>();
  for (const row of rows) {
    const list = byKind.get(row.kind) ?? [];
    list.push(row);
    byKind.set(row.kind, list);
  }

  const out: EvidenceRecord[] = [];
  for (const [kind, list] of byKind) {
    const spec = EVIDENCE_REGISTRY[kind as EvidenceRecordKind];
    if (spec?.window === "rolling_window") {
      const { current } = partitionByWindowRole(list);
      out.push(...current);
      continue;
    }
    if (spec?.window === "sampled_point") {
      out.push(...latestSample(list));
      continue;
    }
    // single_point (and any undeclared shape): the latest row per identity.
    const latest = new Map<string, EvidenceRecord>();
    for (const row of list) {
      const key = identityOf(row);
      const held = latest.get(key);
      if (!held || row.observedAt > held.observedAt) latest.set(key, row);
    }
    out.push(...latest.values());
  }
  return out;
}

/**
 * The comparison window for rolling-window kinds, using the same rule as
 * `currentEvidence`. Empty when the writer has only ever stored one window.
 */
export async function previousWindowEvidenceFromStore(
  db: EvidenceDb,
  options: { projectId: string; kinds?: EvidenceRecordKind[]; asOf?: Date }
): Promise<EvidenceRecord[]> {
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: options.projectId,
      kind: { in: (options.kinds ?? ["keyword_rank"]) as never },
      supersededById: null,
      observedAt: options.asOf ? { lte: options.asOf } : undefined,
    },
  });
  return partitionByWindowRole(rows).previous;
}

export type EvidenceDb = Pick<PrismaClient, "evidenceRecord" | "rawProviderResponse">;export type StoredEvidenceRecord = {
  id: string;
  kind: EvidenceRecordKind;
  projectId: string;
  siteId: string | null;
  observedAt: Date;
  observationHash: string;
  supersededById: string | null;
};

export async function storeEvidenceRecord(
  db: EvidenceDb,
  input: EvidenceRecordPayload
): Promise<StoredEvidenceRecord> {
  if (!EVIDENCE_KINDS.includes(input.kind)) {
    throw new Error(`unknown evidence kind: ${String(input.kind)}`);
  }
  if (!input.producer || input.producer.trim() === "") {
    throw new Error("evidence requires a producer (provenance)");
  }
  if (!(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) {
    throw new Error("evidence requires a valid observedAt (provenance)");
  }
  if (PROVIDER_COLLECTED_KINDS.has(input.kind)) {
    const providerMetrics = Object.entries(input.metrics).filter(([, metric]) => metric.source === "provider");
    if (providerMetrics.length > 0) {
      if (!input.rawResponseId) {
        throw new Error(
          `provider-sourced metrics require a raw response reference (provenance); kind "${input.kind}"`
        );
      }
      const raw = await db.rawProviderResponse.findUnique({
        where: { id: input.rawResponseId },
        select: { costMicros: true, status: true },
      });
      if (!raw) {
        throw new Error("raw provider response not found");
      }
      if (raw.costMicros == null) {
        throw new Error("provider-sourced evidence requires the raw response to record its cost (provenance)");
      }
    }
  }
  for (const [label, metric] of Object.entries(input.metrics)) {
    validateMetricLabel(label, metric);
  }
  validateAgainstRegistry(input);

  const observationHash = computeObservationHash(input);
  const record = await db.evidenceRecord.upsert({
    where: {
      projectId_kind_observationHash: {
        projectId: input.projectId,
        kind: input.kind,
        observationHash,
      },
    },
    create: {
      projectId: input.projectId,
      siteId: input.siteId ?? null,
      kind: input.kind,
      observedAt: input.observedAt,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      producer: input.producer,
      rawResponseId: input.rawResponseId ?? null,
      dimensions: input.dimensions as Prisma.InputJsonValue,
      metrics: input.metrics as unknown as Prisma.InputJsonValue,
      observationHash,
    },
    update: {},
    select: {
      id: true,
      kind: true,
      projectId: true,
      siteId: true,
      observedAt: true,
      observationHash: true,
      supersededById: true,
    },
  });
  return record;
}

/** Supersede, never delete: write the replacement and point the old row at it. */
export async function supersedeEvidenceRecord(
  db: EvidenceDb,
  supersededId: string,
  replacement: EvidenceRecordPayload
): Promise<StoredEvidenceRecord> {
  const replacementRecord = await storeEvidenceRecord(db, replacement);
  await db.evidenceRecord.update({
    where: { id: supersededId },
    data: { supersededById: replacementRecord.id },
  });
  return replacementRecord;
}

export type EvidenceFilter = {
  projectId: string;
  kinds?: EvidenceRecordKind[];
  siteId?: string | null;
  /** Only records that are not superseded (the active view). Default true. */
  activeOnly?: boolean;
};

export async function listActiveEvidence(db: EvidenceDb, filter: EvidenceFilter) {
  return db.evidenceRecord.findMany({
    where: {
      projectId: filter.projectId,
      siteId: filter.siteId ?? undefined,
      kind: filter.kinds ? { in: filter.kinds } : undefined,
      supersededById: filter.activeOnly === false ? undefined : null,
    },
    orderBy: { observedAt: "desc" },
  });
}
