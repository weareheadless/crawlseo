import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildStageUrl, PIPELINE_STAGES, resolvePipelineStage } from "../lib/pipeline/stages";
import { PipelineNavigation } from "../components/pipeline/pipeline-navigation";

describe("pipeline stage contract", () => {
  it("publishes the five ordered stages and maps nested routes", () => {
    expect(PIPELINE_STAGES.map(({ id }) => id)).toEqual(["business", "research", "findings", "work", "results"]);
    expect(resolvePipelineStage("/sites/acme/research/keywords/123")).toBe("research");
    expect(resolvePipelineStage("/sites/acme/crawl/page/1")).toBe("findings");
    expect(resolvePipelineStage("/sites/acme/content-studio/draft/1")).toBe("work");
    expect(resolvePipelineStage("/sites/acme")).toBeNull();
    expect(resolvePipelineStage("/sites/research/settings")).toBeNull();
    expect(resolvePipelineStage("/arbitrary/work")).toBeNull();
    expect(resolvePipelineStage("/sites/acme/research/runs/business")).toBe("research");
    expect(resolvePipelineStage("/crawlseo/sites/acme/work")).toBe("work");
    expect(resolvePipelineStage("/sites/acme/actions/123/details")).toBe("work");
    expect(resolvePipelineStage("/sites/acme/opportunities/123")).toBe("findings");
    expect(resolvePipelineStage("/sites/acme/keywords/123")).toBe("research");
    expect(resolvePipelineStage("/sites/acme/%E0%A4%A")).toBeNull();
    expect(resolvePipelineStage("/settings")).toBeNull();
  });

  it("encodes site scope and path components", () => {
    expect(() => buildStageUrl("../other", "research")).toThrow();
    expect(() => buildStageUrl("..", "research")).toThrow();
    expect(() => buildStageUrl("acme", "research", "../other")).toThrow();
    expect(() => buildStageUrl("acme", "research", "/other")).toThrow();
    const allowed = buildStageUrl("acme-123", "research", "runs/abc_1");
    expect(new URL(allowed, "https://example.test").pathname).toBe("/sites/acme-123/research/runs/abc_1");
    expect(() => buildStageUrl("acme", "nope" as never)).toThrow();
  });

  it("renders an accessible, keyboard-focusable wrapping navigation", () => {
    const html = renderToStaticMarkup(createElement(PipelineNavigation, { siteId: "acme", currentStage: "findings" }));
    expect(html).toContain('aria-label="Site pipeline"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("flex-wrap");
  });
});
