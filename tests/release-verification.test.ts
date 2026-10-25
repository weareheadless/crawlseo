import { describe, expect, it } from "vitest";
import { verifyReleaseOutcome } from "@/lib/research/release-verification";

function response(html: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  } as unknown as Response;
}

describe("release outcome verification", () => {
  it("fails when the H1 is still missing after publish", async () => {
    const result = await verifyReleaseOutcome({
      targetUrl: "https://www.example.com/page",
      evidence: { issue_type: "MISSING_H1", urls: [] },
      fetchImpl: async () => response("<html><body><p>No heading</p></body></html>"),
    });
    expect(result.verified).toBe(false);
    expect(result.failedUrls).toEqual(["https://www.example.com/page"]);
  });

  it("passes when the H1 is present after publish", async () => {
    const result = await verifyReleaseOutcome({
      targetUrl: "https://www.example.com/page",
      evidence: { issue_type: "MISSING_H1", urls: [] },
      fetchImpl: async () => response("<html><body><h1>Heading</h1></body></html>"),
    });
    expect(result.verified).toBe(true);
  });

  it("checks multiple batch URLs and fails if any still reproduces", async () => {
    const result = await verifyReleaseOutcome({
      targetUrl: "https://www.example.com/a",
      evidence: { issue_type: "MISSING_H1", batch: true, urls: ["https://www.example.com/b"] },
      fetchImpl: async (url) => String(url).endsWith("/b")
        ? response("<html><body></body></html>")
        : response("<html><body><h1>Heading</h1></body></html>"),
    });
    expect(result.verified).toBe(false);
    expect(result.failedUrls).toEqual(["https://www.example.com/b"]);
  });
});
