import { describe, expect, it } from "vitest";

import { TYPES_THE_TOPIC_MAP_PRODUCES } from "@/lib/funnel/backfill";
import { opportunityTypesTheTopicMapCanProduce } from "@/lib/research/opportunity-generation";

/**
 * Retirement must not delete a capability the replacement cannot express.
 *
 * ## What went wrong
 *
 * `retireLegacyOpportunitiesForTopicMap` parked every legacy row regardless of type, on the
 * assumption that the topic map replaced the detectors wholesale. It does not: the map's
 * producer emits five of the fourteen declared types.
 *
 * Measured 2026-11-25: 352 rows were retired as "superseded by the topic-map pipeline", and
 * **109 of them were types the map cannot emit at all**:
 *
 * ```
 *  31  O2_striking_distance      (the map has no equivalent)
 *  30  O13_user_pain_point
 *  28  O1_winnable_rank
 *  15  O8_structured_data_gap
 *   4  O10_cannibalization
 *   1  O9_backlink_gap
 * ```
 *
 * That is why cannibalisation looked like it did not exist. The detector runs, writes its
 * rows, and the retirement immediately parks them — a step forward on one feature and two
 * steps back on five others, with the run reporting success.
 *
 * ## The rule this test enforces
 *
 * The retirement list is the *coverage* claim. It must be derived from what the producer can
 * actually emit, and the two must not drift silently in the direction that loses work. A new
 * proposal type added to the producer fails this test until someone decides, explicitly,
 * whether the legacy detector for the same capability should now retire.
 */

describe("the topic map's coverage is a checked claim, not an assumption", () => {
  it("lists exactly the types the producer can emit", () => {
    const produced = opportunityTypesTheTopicMapCanProduce();
    expect([...TYPES_THE_TOPIC_MAP_PRODUCES].sort()).toEqual([...produced].sort());
  });

  it("does not claim to replace a capability it cannot express", () => {
    // The specific losses that were measured. Each is a real analysis with no replacement,
    // so retiring it is a regression dressed as a migration.
    const unreplaceable = [
      "O10_cannibalization",
      "O2_striking_distance",
      "O13_user_pain_point",
      "O1_winnable_rank",
      "O8_structured_data_gap",
      "O9_backlink_gap",
    ] as const;
    for (const type of unreplaceable) {
      expect(TYPES_THE_TOPIC_MAP_PRODUCES).not.toContain(type);
    }
  });

  it("is not empty, so the retirement still does its job for the overlapping types", () => {
    // The guard must not be satisfied by claiming nothing is replaced: then two producers
    // would write the same findings and the board would show each one twice.
    expect(TYPES_THE_TOPIC_MAP_PRODUCES.length).toBeGreaterThan(0);
    expect(TYPES_THE_TOPIC_MAP_PRODUCES).toContain("O3_content_gap");
  });
});
