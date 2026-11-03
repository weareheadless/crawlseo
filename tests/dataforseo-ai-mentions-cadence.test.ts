import { describe, expect, it } from "vitest";

import {
  LLM_MENTIONS_COST_USD,
  llmMentionsGate,
} from "@/lib/dataforseo/ai-mentions-cadence";

/**
 * `llm_mentions` billed $0.101 for one call on 2026-11-03, about 168× an
 * `llm_responses` call. The owner's rule is once per calendar month, so the rule
 * lives in code rather than in someone's memory.
 */
describe("llm_mentions monthly cadence", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");

  it("allows the first snapshot for a site", () => {
    expect(llmMentionsGate(null, now)).toEqual({ allowed: true });
  });

  it("blocks a second snapshot in the same calendar month", () => {
    const gate = llmMentionsGate(new Date("2026-11-01T00:00:00.000Z"), now);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toContain("this calendar month");
      expect(gate.nextEligibleAt.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    }
  });

  it("blocks a run from earlier the same day", () => {
    expect(llmMentionsGate(new Date("2026-11-03T09:00:00.000Z"), now).allowed).toBe(false);
  });

  it("allows a run once the month rolls over", () => {
    expect(llmMentionsGate(new Date("2026-10-31T23:00:00.000Z"), now).allowed).toBe(true);
  });

  it("keeps the recorded cost visible to budget code", () => {
    // If the provider changes the price, this number has to be re-verified.
    expect(LLM_MENTIONS_COST_USD).toBe(0.101);
  });
});
