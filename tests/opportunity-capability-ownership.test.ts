import { describe, expect, it } from "vitest";

import {
  ALL_CAPABILITIES,
  CAPABILITY_PRODUCER,
  capabilitiesOwnedBy,
} from "@/lib/funnel/capabilities";
import { DETECTOR_REQUIRES } from "@/lib/funnel/detectors";
import { opportunityTypesTheTopicMapCanProduce } from "@/lib/research/opportunity-generation";

/**
 * Ownership is a declared, checked property of every capability.
 *
 * The failure this guards against was measured on 2026-11-25: the topic map emits 5 of the 14
 * declared types, `refreshFunnelForSite` skipped the detectors entirely for every tenant that had
 * modelled clusters — which was all 8 — and the retirement sweep parked 109 rows of capability
 * the topic map cannot express as "superseded by the topic-map pipeline". Nine capabilities had
 * no producer and no report saying so, while the run claimed success.
 *
 * A capability without an owner is a capability nobody produces. That must be impossible to
 * introduce by accident, in either direction: not by adding a type, and not by a producer
 * claiming coverage it does not have.
 */

describe("opportunity capability ownership", () => {
  it("names an owner for every declared capability", () => {
    const unowned = ALL_CAPABILITIES.filter((type) => CAPABILITY_PRODUCER[type] == null);
    expect(unowned).toEqual([]);
    expect(ALL_CAPABILITIES).toHaveLength(14);
  });

  it("gives the topic map exactly the types its producer can emit", () => {
    // The coverage claim is derived from the producer, not maintained beside it. If the
    // proposal pipeline learns a new lane that maps to a new type, this fails until someone
    // decides whether the detector for that capability should now stand down.
    const produced = opportunityTypesTheTopicMapCanProduce();
    expect([...capabilitiesOwnedBy("topic-map")].sort()).toEqual([...produced].sort());
  });

  it("partitions the board, so no capability has two owners and none has zero", () => {
    const topicMap = capabilitiesOwnedBy("topic-map");
    const detectors = capabilitiesOwnedBy("detectors");
    expect(new Set([...topicMap, ...detectors]).size).toBe(ALL_CAPABILITIES.length);
    expect(topicMap.length + detectors.length).toBe(ALL_CAPABILITIES.length);
    // Both producers must own something, or one of them is dead weight writing no work.
    expect(topicMap.length).toBeGreaterThan(0);
    expect(detectors.length).toBeGreaterThan(0);
  });

  it("does not claim to replace a capability the topic map cannot express", () => {
    // The specific losses that were measured. Each is a real analysis with no equivalent in
    // the proposal pipeline, so retiring it is a regression dressed as a migration.
    const unreplaceable = [
      "O1_winnable_rank",
      "O2_striking_distance",
      "O5_aeo_presence_gap",
      "O8_structured_data_gap",
      "O9_backlink_gap",
      "O10_cannibalization",
      "O13_user_pain_point",
    ] as const;
    for (const type of unreplaceable) {
      expect(CAPABILITY_PRODUCER[type]).toBe("detectors");
    }
  });

  it("gives every detector-owned capability a detector that can produce it", () => {
    // An owned capability with no detector behind it is the same silence as an unowned one.
    // `DETECTOR_REQUIRES` is the declared list of detectors and the evidence each needs.
    for (const type of capabilitiesOwnedBy("detectors")) {
      expect(DETECTOR_REQUIRES[type], `${type} has no detector`).toBeDefined();
    }
  });

  it("declares the evidence each capability needs, so absence is nameable", () => {
    // "This capability cannot run because X was never collected" has to be computable. A type
    // with no declared evidence requirement cannot produce that sentence.
    for (const type of ALL_CAPABILITIES) {
      expect(Array.isArray(DETECTOR_REQUIRES[type]), `${type} declares no evidence`).toBe(true);
    }
  });
});
