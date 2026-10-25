import { describe, expect, it } from "vitest";
import { sourceRecencyIssue, sourceWithinRecencyWindow } from "@/lib/research/quality";

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
});
