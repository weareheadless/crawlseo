import { describe, expect, it, vi } from "vitest";

import { keywordRowsForScreen, keywordRowsFromEvidence, rawTaskIdForRun } from "@/lib/dataforseo/keyword-evidence-view";

const run = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  providerTaskId: "task-1",
  result: [{ keyword: "stored", volume: 10, difficulty: 1, cpc: 0.1, competition: 0.2 }],
  ...over,
});

function fakeDb(opts: { raw?: { id: string } | null; records?: Array<Record<string, unknown>>; throws?: boolean }) {
  return {
    rawProviderResponse: {
      findUnique: vi.fn(async () => {
        if (opts.throws) throw new Error("db down");
        return opts.raw ?? null;
      }),
    },
    evidenceRecord: {
      findMany: vi.fn(async () => opts.records ?? []),
    },
  } as never;
}

const record = (query: string, volume: number | null, extra: Record<string, number> = {}) => ({
  dimensions: { query },
  metrics: {
    ...(volume == null ? {} : { "provider:volume": { value: volume } }),
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [`provider:${key}`, { value }])),
  },
});

describe("keyword research reads evidence (DS-02 read half)", () => {
  it("derives the raw response identity the bridge used", () => {
    expect(rawTaskIdForRun({ id: "r1", providerTaskId: "p1" })).toBe("p1");
    expect(rawTaskIdForRun({ id: "r1", providerTaskId: null })).toBe("stored-run:r1");
  });

  it("maps evidence rows with declared provider metrics, highest volume first", async () => {
    const db = fakeDb({
      raw: { id: "raw-1" },
      records: [record("low", 10), record("high", 900, { difficulty: 30, cpc: 0.5, competition: 0.7 })],
    });
    const rows = await keywordRowsFromEvidence(db, run());
    expect(rows?.map((row) => row.keyword)).toEqual(["high", "low"]);
    expect(rows?.[0]).toMatchObject({ volume: 900, difficulty: 30, cpc: 0.5, competition: 0.7, intent: null, trend: null });
  });

  it("returns null when the run was never bridged, so the caller can fall back", async () => {
    const db = fakeDb({ raw: null });
    expect(await keywordRowsFromEvidence(db, run())).toBeNull();
  });

  it("returns null when the raw response exists but has no keyword evidence", async () => {
    const db = fakeDb({ raw: { id: "raw-1" }, records: [] });
    expect(await keywordRowsFromEvidence(db, run())).toBeNull();
  });

  it("falls back to the stored result and says so", async () => {
    const db = fakeDb({ raw: null });
    const result = await keywordRowsForScreen(db, run());
    expect(result.source).toBe("stored_result");
    expect(result.rows[0].keyword).toBe("stored");
  });

  it("prefers evidence and labels the source", async () => {
    const db = fakeDb({ raw: { id: "raw-1" }, records: [record("from evidence", 500)] });
    const result = await keywordRowsForScreen(db, run());
    expect(result.source).toBe("evidence");
    expect(result.rows[0].keyword).toBe("from evidence");
  });

  it("degrades to the stored result when the evidence read throws", async () => {
    const db = fakeDb({ throws: true });
    const result = await keywordRowsForScreen(db, run());
    expect(result.source).toBe("stored_result");
    expect(result.rows[0].keyword).toBe("stored");
  });

  it("handles a run with no rows at all without throwing", async () => {
    const db = fakeDb({ raw: null });
    const result = await keywordRowsForScreen(db, run({ result: null }));
    expect(result).toEqual({ rows: [], source: "stored_result" });
  });
});
