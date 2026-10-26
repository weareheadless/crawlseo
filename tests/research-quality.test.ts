import { describe, expect, it } from "vitest";
import { observationWithinRecencyWindow, sourceRecencyIssue, sourceWithinRecencyWindow } from "@/lib/research/quality";
import { normalizeResearchSourceUrl } from "@/lib/research/evidence";

describe("research source recency quality", () => {
  const now = Date.parse("2026-10-25T12:00:00.000Z");

  it("does not treat undated sources as fresh and rejects invalid or materially future dates", () => {
    expect(sourceWithinRecencyWindow(undefined, 30, now)).toBe(false);
    expect(sourceRecencyIssue(undefined, 30, now)).toBe("missing_date");
    expect(sourceWithinRecencyWindow("not-a-date", 30, now)).toBe(false);
    expect(sourceRecencyIssue("not-a-date", 30, now)).toBe("invalid_date");
    expect(sourceWithinRecencyWindow("2026-10-26T00:00:00.000Z", 30, now)).toBe(false);
    expect(sourceRecencyIssue("2026-10-26T00:00:00.000Z", 30, now)).toBe("future_date");
    expect(sourceWithinRecencyWindow("2026-10-25T12:04:00.000Z", 30, now)).toBe(true);
  });

  it("applies the configured maximum evidence age", () => {
    expect(sourceWithinRecencyWindow("2026-09-25T12:00:00.000Z", 30, now)).toBe(true);
    expect(sourceWithinRecencyWindow("2026-09-24T11:59:59.999Z", 30, now)).toBe(false);
    expect(sourceRecencyIssue("2026-09-24T11:59:59.999Z", 30, now)).toBe("stale");
  });

  it("normalizes provider URL identity while preserving meaningful parameters", () => {
    expect(normalizeResearchSourceUrl("HTTPS://Example.COM:443/a/?utm_source=x&b=2&ref=y&a=1#part"))
      .toBe("https://example.com/a?a=1&b=2");
    expect(normalizeResearchSourceUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeResearchSourceUrl("javascript:alert(1)")).toBeNull();
  });

  it("uses stored retrieval time and the bounded request recency window", () => {
    expect(observationWithinRecencyWindow("2026-10-01T12:00:00.000Z", 30, now)).toBe(true);
    expect(observationWithinRecencyWindow("2023-01-01T00:00:00.000Z", 1000, now)).toBe(false);
    expect(observationWithinRecencyWindow(null, 30, now)).toBe(false);
  });
});
