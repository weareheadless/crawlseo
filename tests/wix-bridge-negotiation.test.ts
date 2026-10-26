/* eslint-disable @typescript-eslint/no-explicit-any -- controlled CLI fixture response. */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state: any = { response: { version: "0.1.0" } };
  const execFile = vi.fn((_file: string, args: string[], _options: unknown, callback: (...values: any[]) => void) => {
    callback(null, JSON.stringify(state.response), "");
  });
  return { state, execFile };
});

vi.mock("node:child_process", () => ({ execFile: h.execFile }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  h.execFile.mockClear();
});

describe("runtime Wix bridge negotiation", () => {
  it("inspects before dispatch and blocks a generic bridge with no explicit capabilities", async () => {
    vi.stubEnv("WIX_BRIDGE_ROOT", "/tmp/wix-bridge-capability-fixture");
    h.state.response = { version: "0.1.0" };
    vi.resetModules();
    const { assertNegotiatedWixBridgeOperations } = await import("@/lib/bridge/client");

    await expect(assertNegotiatedWixBridgeOperations("fixture", ["read_embed"])).rejects.toThrow(/unsupported or unnegotiated/);
    expect(h.execFile).toHaveBeenCalledTimes(1);
    expect(h.execFile.mock.calls[0][1]).toContain("inspect");
  });

  it("does not promote host-only update-snippet even when a bridge declares adjacent embed support", async () => {
    vi.stubEnv("WIX_BRIDGE_ROOT", "/tmp/wix-bridge-capability-fixture");
    h.state.response = {
      contract: "wix-bridge-generic-v1",
      capabilities: { inspect: true, read_embed: true, write_embed: true, update_snippet: true },
    };
    vi.resetModules();
    const { assertNegotiatedWixBridgeOperations } = await import("@/lib/bridge/client");

    await expect(assertNegotiatedWixBridgeOperations("fixture", ["read_embed", "update_snippet"]))
      .rejects.toThrow(/update_snippet/);
    expect(h.execFile).toHaveBeenCalledTimes(1);
    expect(h.execFile.mock.calls[0][1]).toContain("inspect");
  });
});
