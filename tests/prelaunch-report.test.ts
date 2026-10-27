import { describe, expect, it } from "vitest";
import { prelaunchTaskView, prelaunchSkipReasons } from "@/lib/dataforseo/prelaunch-report";

describe("prelaunch report stored-data rendering", () => {
  it("renders per-task cost, status, keyword metrics and explicit skip reasons", () => {
    const task = prelaunchTaskView({ id: "t", kind: "KEYWORD_SEED", status: "COMPLETED", costMicros: 62400, input: { seed: "plumber" }, result: [{ keyword: "plumber", volume: 20, difficulty: 5, intent: "commercial" }], errorCode: null });
    expect(task).toMatchObject({ seed: "plumber", status: "COMPLETED", costMicros: 62400, keywords: [{ keyword: "plumber", volume: "20", difficulty: "5", intent: "commercial" }] });
    expect(prelaunchSkipReasons({ skipped: [{ task: "own_domain", reason: "no_domain_available" }] })).toEqual([{ task: "own_domain", reason: "no_domain_available" }]);
  });
  it("shows absent provider fields as unknown", () => {
    expect(prelaunchTaskView({ id: "t", kind: "KEYWORD_SEED", status: "COMPLETED", costMicros: null, input: {}, result: [{ keyword: "term" }], errorCode: null }).keywords[0]).toEqual({ keyword: "term", volume: "Unknown", difficulty: "Unknown", intent: "Unknown" });
  });
});
