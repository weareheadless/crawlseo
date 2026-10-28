import { describe, expect, it } from "vitest";
import { buildStageUrl, PIPELINE_STAGES, resolvePipelineStage } from "../lib/pipeline/stages";

describe("pipeline stage contract", () => {
  it("publishes the five ordered stages and maps nested routes", () => {
    expect(PIPELINE_STAGES.map(({ id }) => id)).toEqual(["business", "research", "findings", "work", "results"]);
    expect(resolvePipelineStage("/sites/acme/research/keywords/123")).toBe("research");
    expect(resolvePipelineStage("/sites/acme/crawl/page/1")).toBe("findings");
    expect(resolvePipelineStage("/sites/acme/content-studio/draft/1")).toBe("work");
    expect(resolvePipelineStage("/sites/acme")).toBeNull();
  });

  it("encodes site scope and path components", () => {
    expect(buildStageUrl("acme/../../other?x", "research", "a/b?x")).toBe("/sites/acme%2F..%2F..%2Fother%3Fx/research/a/b%3Fx");
  });
});
