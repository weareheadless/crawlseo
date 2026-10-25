import { describe, expect, it } from "vitest";
import { researchCompletionStatus } from "@/lib/research/runner";

describe("research completion state", () => {
  it("keeps empty provider responses as a partial run with no evidence", () => {
    expect(researchCompletionStatus([], 0)).toBe("PARTIAL");
  });

  it("keeps provider failures visible as partial even when other sources were saved", () => {
    expect(researchCompletionStatus(["news: HTTP 503"], 4)).toBe("PARTIAL");
  });

  it("completes only when at least one source is saved without provider errors", () => {
    expect(researchCompletionStatus([], 1)).toBe("COMPLETED");
  });
});
