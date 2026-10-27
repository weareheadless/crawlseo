import { describe, expect, it } from "vitest";
import {
  AI_VISIBILITY_CAPABILITY_VERSION,
  AI_VISIBILITY_CAPABILITY_INVENTORY,
  AI_VISIBILITY_UNKNOWN_REASON,
  providerCapabilityMatrixSchema,
  visibilityFromAccessSignals,
} from "@/lib/research/ai-visibility-capabilities";

const matrix = {
  version: AI_VISIBILITY_CAPABILITY_VERSION,
  providers: [
    { provider: "ExampleAI", dashboard: { availability: "unknown", reasonCode: "not_inventoried" }, apiOrExport: { availability: "unknown", reasonCode: "not_inventoried" }, unavailableSurfaces: [] },
  ],
};

describe("AI visibility capability inventory", () => {
  it("validates per-provider dashboard, API/export, and unavailable surfaces", () => {
    expect(providerCapabilityMatrixSchema.parse(matrix)).toEqual(matrix);
    expect(providerCapabilityMatrixSchema.safeParse({ ...matrix, version: "future" }).success).toBe(false);
  });
  it("renders a code-level matrix with unavailable surfaces called out explicitly", () => {
    const parsed = providerCapabilityMatrixSchema.parse(AI_VISIBILITY_CAPABILITY_INVENTORY);
    expect(parsed.providers.length).toBeGreaterThan(0);
    expect(parsed.providers.every((provider) => Array.isArray(provider.unavailableSurfaces))).toBe(true);
    expect(parsed.providers[0].dashboard.availability).toBe("unknown");
  });

  it("represents unobserved surfaces as unknown with reason codes, never numeric zero", () => {
    const parsed = providerCapabilityMatrixSchema.parse(matrix);
    expect(parsed.providers[0].dashboard).toEqual({ availability: "unknown", reasonCode: "not_inventoried" });
    expect(JSON.stringify(parsed)).not.toMatch(/(?:mentions|citations|ranking|score).*0/i);
  });

  it.each([
    { robotsAllows: true }, { sitemapContainsUrl: true }, { botUserAgent: "ExampleBot" }, { httpStatus: 200 },
  ])("does not derive visibility from access evidence %#", (signal) => {
    expect(visibilityFromAccessSignals(signal)).toEqual({ status: "unknown", reasonCode: AI_VISIBILITY_UNKNOWN_REASON.NOT_OBSERVED });
  });

  it("replays the stable versioned matrix", () => {
    expect(providerCapabilityMatrixSchema.parse(JSON.parse(JSON.stringify(matrix)))).toEqual(matrix);
    expect(AI_VISIBILITY_CAPABILITY_VERSION).toBe("ai-capabilities-v1");
  });
});
