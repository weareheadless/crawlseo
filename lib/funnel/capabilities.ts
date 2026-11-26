import type { OpportunityType } from "@prisma/client";

/**
 * Who owns each opportunity capability.
 *
 * ## Why this file exists
 *
 * The board has one table and two producers: the topic map (`phase3:topic-map`, model
 * proposals derived from the demand map) and the detectors (`runDetectors`, arithmetic on
 * stored evidence). Ownership was never declared — it was inferred from prose in
 * `refreshFunnelForSite` ("one board per project; the legacy detectors would add a second,
 * differently-reasoned list of work") and from whichever producer happened to run last.
 *
 * That inference was wrong in the direction that loses work, twice over:
 *
 * 1. **Production.** `refreshFunnelForSite` returned early whenever the project had modelled
 *    clusters, so `runDetectors` never ran. Measured 2026-11-25: all 8 tenants have modelled
 *    clusters, so no detector ran in production for any of them. The topic map emits 5 of the
 *    14 declared types, so 9 capabilities had no producer at all — cannibalisation, striking
 *    distance, winnable rank, AEO presence, structured data, backlink gap, page experience,
 *    user pain point, business fact mismatch.
 * 2. **Retirement.** `retireLegacyOpportunitiesForTopicMap` parked every legacy row regardless
 *    of type, filing 109 rows of capability the topic map cannot express as "superseded by the
 *    topic-map pipeline".
 *
 * Both looked like success. The run reported `opportunities are owned by the topic map`, and
 * the census showed a healthy board, because the missing work was missing rather than failed.
 * That is the mechanism behind "one step forward, two steps back": a new producer takes over
 * the board, and the capabilities it cannot express are deleted by the takeover rather than
 * handed to it.
 *
 * ## The rule
 *
 * Ownership is a property of the **capability**, not of the writer. `detectedBy` records which
 * run wrote a row — there are 23 distinct values in production, most of them one-off analysis
 * and verification scripts — so scoping a state transition by `detectedBy` would strand every
 * row written by a producer that no longer runs. Scoping by the type's declared owner means the
 * current owner can maintain rows its predecessors wrote, and no producer can evict work it does
 * not own.
 *
 * A producer may create rows of, and change the state of rows of, exactly the types it owns.
 * Nothing else: not hysteresis, not the open cap, not retirement, not staleness sweeps.
 */

/** The two producers that write the opportunity board. */
export type CapabilityProducer = "topic-map" | "detectors";

/**
 * The producer of record for each capability.
 *
 * The topic map owns the types its proposal pipeline can express; that set is checked against
 * `opportunityTypesTheTopicMapCanProduce()` by `tests/opportunity-capability-ownership.test.ts`,
 * so this table cannot drift from what the producer actually emits. The detectors own the rest,
 * which is the set that only exists as arithmetic over stored evidence.
 *
 * Adding a type means adding an owner. A type with no owner is a capability nobody produces,
 * and that is what this table exists to make impossible.
 */
export const CAPABILITY_PRODUCER: Record<OpportunityType, CapabilityProducer> = {
  O1_winnable_rank: "detectors",
  O2_striking_distance: "detectors",
  O3_content_gap: "topic-map",
  O4_aeo_citation_gap: "topic-map",
  O5_aeo_presence_gap: "detectors",
  O6_business_fact_mismatch: "detectors",
  O7_technical_defect: "topic-map",
  O8_structured_data_gap: "detectors",
  O9_backlink_gap: "detectors",
  O10_cannibalization: "detectors",
  O11_freshness_decay: "topic-map",
  O12_page_experience: "detectors",
  O13_user_pain_point: "detectors",
  O14_offer_positioning_gap: "topic-map",
};

/** Every declared capability. Derived, so a new enum member cannot be silently unowned. */
export const ALL_CAPABILITIES = Object.keys(CAPABILITY_PRODUCER) as OpportunityType[];

/** The types one producer owns. */
export function capabilitiesOwnedBy(producer: CapabilityProducer): OpportunityType[] {
  return ALL_CAPABILITIES.filter((type) => CAPABILITY_PRODUCER[type] === producer);
}

/** The producer of record for one capability. */
export function ownerOf(type: OpportunityType): CapabilityProducer {
  return CAPABILITY_PRODUCER[type];
}
