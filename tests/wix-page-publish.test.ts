import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  publish: vi.fn(async () => ({ status: "ok", published: true })),
  seo: vi.fn(async () => ({ status: "ok", route: "/agenda", pageId: "page-1", published: true })),
  negotiate: vi.fn(async () => undefined),
}));

vi.mock("@/lib/bridge/client", () => ({
  assertNegotiatedWixBridgeOperations: h.negotiate,
  publishBridgeSite: h.publish,
  setBridgePageSeo: h.seo,
}));

import { pageServesPacket, publishDeliveredPage } from "@/lib/delivery/wix-early-packet";

const packet = (key: string) => `<html><head><script>(()=>{const k="${key}";})();</script></head></html>`;

const page = (key: string, title: string, description: string) =>
  `<html><head><title>${title}</title><meta name="description" content="${description}"><script>(()=>{const k="${key}";})();</script></head></html>`;

function liveResponses(bodies: string[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const body = bodies.length > 1 ? bodies.shift() : bodies[0];
    return new Response(body ?? "", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  h.publish.mockClear();
  h.seo.mockClear();
  h.negotiate.mockClear();
});

describe("page publish verification", () => {
  it("reports a page that serves the delivery's packet", async () => {
    liveResponses([packet("abc123")]);
    await expect(pageServesPacket("https://example.com/agenda", "abc123")).resolves.toBe(true);
    await expect(pageServesPacket("https://example.com/agenda", "other")).resolves.toBe(false);
  });

  it("reports an unreadable page as unknown, not as a match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(pageServesPacket("https://example.com/agenda", "abc123")).resolves.toBeNull();
  });

  it("publishes once when the live page already serves the packet", async () => {
    liveResponses([packet("abc123")]);
    const result = await publishDeliveredPage({
      alias: "example",
      url: "https://example.com/agenda",
      packetKey: "abc123",
      waitAttempts: 2,
      waitDelayMs: 0,
    });
    expect(result.status).toBe("verified");
    expect(result.attempts).toBe(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledWith("example", true);
  });

  it("publishes again when an older packet is still served", async () => {
    // The first publish leaves the old packet; the second one applies the new one.
    liveResponses([packet("old"), packet("old"), packet("old"), packet("abc123")]);
    const result = await publishDeliveredPage({
      alias: "example",
      url: "https://example.com/agenda",
      packetKey: "abc123",
      waitAttempts: 2,
      waitDelayMs: 0,
    });
    expect(result.status).toBe("verified");
    expect(result.attempts).toBe(2);
    expect(result.publishes).toBe(2);
  });

  it("reports an unpublished page as pending instead of claiming success", async () => {
    liveResponses([packet("old")]);
    const result = await publishDeliveredPage({
      alias: "example",
      url: "https://example.com/agenda",
      packetKey: "abc123",
      attempts: 2,
      waitAttempts: 1,
      waitDelayMs: 0,
    });
    expect(result.status).toBe("pending");
    expect(result.publishes).toBe(2);
  });

  it("sets the SEO tags only after the packet is live, then verifies both", async () => {
    liveResponses([
      packet("old"),
      page("abc123", "Old title", "Old description"),
      page("abc123", "New title", "New description"),
    ]);
    const result = await publishDeliveredPage({
      alias: "example",
      url: "https://example.com/agenda",
      packetKey: "abc123",
      seo: { title: "New title", description: "New description" },
      attempts: 1,
      waitAttempts: 3,
      waitDelayMs: 0,
    });
    expect(result.status).toBe("verified");
    expect(h.seo).toHaveBeenCalledTimes(1);
    expect(h.seo).toHaveBeenCalledWith("example", "/agenda", { title: "New title", description: "New description" }, true);
  });

  it("reports a page whose title or description is still the old one", async () => {
    liveResponses([page("abc123", "Old title", "Old description")]);
    const result = await publishDeliveredPage({
      alias: "example",
      url: "https://example.com/agenda",
      packetKey: "abc123",
      seo: { title: "New title", description: "New description" },
      attempts: 1,
      waitAttempts: 1,
      waitDelayMs: 0,
    });
    expect(result.status).toBe("pending");
    expect(result.attempts).toBe(1);
  });

  it("reports a failed SEO write with its reason", async () => {
    liveResponses([page("abc123", "Old title", "Old description")]);
    h.seo.mockRejectedValueOnce(new Error("Wix SEO request failed (HTTP 403)."));
    const result = await publishDeliveredPage({
      alias: "example",
      url: "https://example.com/agenda",
      packetKey: "abc123",
      seo: { title: "New title", description: "New description" },
      attempts: 1,
      waitAttempts: 1,
      waitDelayMs: 0,
    });
    expect(result.status).toBe("failed");
    expect(result.seo?.status).toBe("failed");
    expect((result.seo as { error: string }).error).toContain("403");
  });

  it("reports a failed publish with its reason", async () => {
    liveResponses([packet("abc123")]);
    h.publish.mockRejectedValueOnce(new Error("Wix SEO request failed (HTTP 403)."));
    const result = await publishDeliveredPage({
      alias: "example",
      url: "https://example.com/agenda",
      packetKey: "abc123",
    });
    expect(result.status).toBe("failed");
    expect(result.publishes).toBe(0);
    expect(result.error).toContain("403");
  });
});
