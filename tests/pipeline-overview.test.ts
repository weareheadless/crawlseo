import { describe, expect, it } from "vitest";
import { readPipelineOverview } from "@/lib/pipeline/overview";

describe("pipeline overview reader contract", () => {
  it("exports a scoped read model without a mutation interface", () => {
    expect(readPipelineOverview).toBeTypeOf("function");
    expect(readPipelineOverview.length).toBe(1);
  });
});
