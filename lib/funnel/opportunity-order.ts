import type { Prisma } from "@prisma/client";

/**
 * One ordering for every surface that shows or evicts an opportunity.
 *
 * `scoreValue: "desc"` was written in four places — the board, the run report's top
 * five, the SERP watch list, and `applyOpenCap`'s overflow — and they did not agree on
 * the tie-break: three said newest first, the cap said oldest first. That is not a
 * cosmetic difference. The cap decides *which rows park*, so changing the scorer while
 * leaving the cap alone would reorder the board and silently evict a different set.
 *
 * So the ordering lives here, once, and every caller asks for it. Adding a fifth
 * surface means calling `opportunityOrder`; there is no second correct answer to reach
 * for.
 *
 * ## D1: the evidence class orders the board, the score orders within it
 *
 * One number cannot do both jobs. `scoreValue` answers "how much is this worth"; it
 * cannot also answer "how sure are we that the worth is real". A projection with a big
 * number beat a measurement with a small one, and this is the alaguillotine inversion:
 *
 * ```
 * 42  estimated   a hub behind a page that does not exist
 *  3  measured    'alex karp height', ranking 29 with 76 real impressions
 * ```
 *
 * A projection may never displace a measurement. So the order is
 * `measured -> estimated -> technical -> hypothesis`, and score sorts within a class.
 * An `estimated` row is not punished for lacking measurement — it keeps its number — it
 * is placed where its confidence belongs. That is "missing evidence is not negative
 * evidence" applied to ordering rather than to weighting.
 *
 * `technical` sits after `estimated` because a defect is ordered by severity and reach
 * on a scale that is not comparable to clicks; its own branch already computes that.
 *
 * ## The tie-break
 *
 * First-detected *ascending*: older work first. Two rows in the same class with the same
 * score are equally worth doing, and the one that has waited longer is the one to show.
 * The board and the SERP list said newest-first and the cap said oldest-first; oldest is
 * the one that does not punish a row for being found early.
 */

/** The columns an opportunity is ordered by. Exported so a test can walk them. */
export const OPPORTUNITY_ORDER_KEYS = ["evidenceClass", "scoreValue", "firstDetectedAt"] as const;

/**
 * The evidence classes, best first.
 *
 * Exported because the board prints the class beside the number and the label has to
 * agree with the sort. `technical` follows the two click-based classes on the strength
 * of its placement, not as a claim that a defect is worse evidence — it is a different
 * scale, and its own branch orders it by severity and reach.
 */
export const EVIDENCE_CLASS_ORDER = ["measured", "estimated", "technical", "hypothesis"] as const;

export type EvidenceClassValue = (typeof EVIDENCE_CLASS_ORDER)[number];

/** The rank of a class in the board's order. An unrecognised class sorts as a hypothesis. */
export function evidenceClassRank(value: string | null | undefined): number {
  const index = EVIDENCE_CLASS_ORDER.indexOf((value ?? "hypothesis") as EvidenceClassValue);
  return index === -1 ? EVIDENCE_CLASS_ORDER.length - 1 : index;
}

/**
 * Prisma's own order-by type for this model, so the constant is checked against the
 * client rather than against a hand-written guess. If the schema gains a column this
 * ordering wants, the type here is what says so.
 */
type OpportunityOrderBy = Prisma.OpportunityOrderByWithRelationInput;

/**
 * The order as Prisma `orderBy`, for a database read.
 *
 * `scoreValue` is nullable in the schema. Postgres sorts NULLs first under `DESC`,
 * which would put an unscored row at the top of the board; `nulls: "last"` states the
 * intent in the order itself rather than relying on what the database happens to do.
 * There are none today (measured 2026-11-25: 0 of 2,010), and this is what makes that
 * safe to keep being true.
 */
export function opportunityOrder(): OpportunityOrderBy[] {
  // A function, not a shared constant, because Prisma mutates the array it is given
  // and one caller's mutation would reorder another surface.
  return [
    // D1: a projection never displaces a measurement. The enum is declared in this
    // order, so the database's own sort agrees with `evidenceClassRank`.
    { evidenceClass: "asc" },
    // Unscored rows last, stated in the order rather than left to what the database
    // does with NULL under DESC.
    { scoreValue: { sort: "desc", nulls: "last" } },
    // Equally-scored work: the row that has waited longer is the one to show.
    { firstDetectedAt: "asc" },
  ];
}

/** The row shape the comparator needs. Deliberately narrow: anything more is a lie. */
export type OrderableOpportunity = {
  evidenceClass?: string | null;
  scoreValue?: number | null;
  firstDetectedAt?: Date | string | null;
};

function timeOf(row: OrderableOpportunity): number {
  const value = row.firstDetectedAt;
  if (value == null) return Number.POSITIVE_INFINITY; // undated work goes last
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * The same ordering in memory, for a set that is already loaded.
 *
 * Two forms exist because two callers have different constraints: the board paginates
 * in SQL, and the cap and the report hold an array. They must not be allowed to drift,
 * so `tests/opportunity-order.test.ts` asserts they produce the same permutation of the
 * same rows.
 */
export function compareOpportunities(a: OrderableOpportunity, b: OrderableOpportunity): number {
  // D1 first: the class decides which band a row is in, and only then does the score
  // decide its place inside that band.
  const classDelta = evidenceClassRank(a.evidenceClass) - evidenceClassRank(b.evidenceClass);
  if (classDelta !== 0) return classDelta;

  const as = a.scoreValue;
  const bs = b.scoreValue;
  // An unscored row is not a zero-scored row: it has no assessment yet, so it sorts
  // after every assessed row regardless of direction.
  const aScored = typeof as === "number" && Number.isFinite(as);
  const bScored = typeof bs === "number" && Number.isFinite(bs);
  if (aScored && !bScored) return -1;
  if (!aScored && bScored) return 1;
  if (aScored && bScored && as !== bs) return bs - as;
  return timeOf(a) - timeOf(b);
}

/** Sort a loaded set into board order. */
export function sortOpportunities<T extends OrderableOpportunity>(rows: readonly T[]): T[] {
  return [...rows].sort(compareOpportunities);
}
