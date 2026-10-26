import { describe, expect, it } from "vitest";
import { assertWixBridgeCapability, negotiateWixBridgeCapabilities } from "@/lib/bridge/client";

describe("Wix bridge capability negotiation", () => {
  it("fails closed when a bridge omits its capability declaration", () => {
    expect(negotiateWixBridgeCapabilities({ version: "0.1.0" })).toEqual({
      inspect: false,
      plan: false,
      deploy: false,
      publish: false,
      release: false,
      verify: false,
      read_embed: false,
      write_embed: false,
      update_snippet: false,
      private_editor_revision: false,
      cms: false,
      seo_tags: false,
    });
    expect(() => assertWixBridgeCapability({}, "cms")).toThrow("unsupported or unnegotiated: cms");
  });

  it("accepts only explicitly declared operations and never infers neighboring support", () => {
    const capabilities = negotiateWixBridgeCapabilities({
      contract: "wix-bridge-generic-v1",
      capabilities: { inspect: true, plan: true, read_embed: true, write_embed: true },
    });
    expect(capabilities.inspect).toBe(true);
    expect(capabilities.write_embed).toBe(true);
    expect(capabilities.publish).toBe(false);
    expect(capabilities.release).toBe(false);
    expect(capabilities.update_snippet).toBe(false);
    expect(capabilities.private_editor_revision).toBe(false);
    expect(capabilities.cms).toBe(false);
    expect(capabilities.seo_tags).toBe(false);
    expect(() => assertWixBridgeCapability({ contract: "wix-bridge-generic-v1", capabilities: { deploy: true } }, "release")).toThrow();
  });
});
