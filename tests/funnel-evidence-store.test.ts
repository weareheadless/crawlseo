import { describe, expect, it, vi } from "vitest";

import {
  EVIDENCE_KINDS,
  PROVIDER_COLLECTED_KINDS,
  computeObservationHash,
  listActiveEvidence,
  storeEvidenceRecord,
  supersedeEvidenceRecord,
  type EvidenceRecordPayload,
} from "@/lib/funnel/evidence";

const base = (overrides: Partial<EvidenceRecordPayload> = {}): EvidenceRecordPayload => ({
  projectId: "p1",
  kind: "keyword_rank",
  observedAt: new Date("2026-11-02T00:00:00.000Z"),
  producer: "rank-tracking-detector",
  rawResponseId: "raw1",
  dimensions: { query: "local seo", url: "https://example.com/services" },
  metrics: {
    "provider:position": { value: 7, unit: "rank", source: "provider" },
  },
  ...overrides,
});

const raw = (overrides: Partial<{ costMicros: bigint | null; status: string }> = {}) => ({
  costMicros: BigInt(1200) as bigint | null,
  status: "succeeded",
  ...overrides,
});

const db = (rawOverrides?: Partial<{ costMicros: bigint; status: string }>) => {
  const upsert = vi.fn().mockResolvedValue({
    id: "ev1",
    kind: "keyword_rank",
    projectId: "p1",
    siteId: null,
    observedAt: new Date("2026-11-02T00:00:00.000Z"),
    observationHash: "hash1",
    supersededById: null,
  });
  return {
    evidenceRecord: { upsert, update: vi.fn().mockResolvedValue({}) },
    rawProviderResponse: { findUnique: vi.fn().mockResolvedValue(raw(rawOverrides)) },
  };
};

describe("evidence store (plan §4 invariants)", () => {
  it("stores a record with provenance and namespaced metrics", async () => {
    const client = db();
    const record = await storeEvidenceRecord(client as never, base());
    expect(record.id).toBe("ev1");
    expect(client.evidenceRecord.upsert).toHaveBeenCalledTimes(1);
    const args = client.evidenceRecord.upsert.mock.calls[0][0];
    expect(args.create.producer).toBe("rank-tracking-detector");
    expect(args.create.rawResponseId).toBe("raw1");
    expect(args.create.observationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects provider-collected kinds without a raw response reference", async () => {
    for (const kind of PROVIDER_COLLECTED_KINDS) {
      const client = db();
      await expect(
        storeEvidenceRecord(client as never, base({ kind: kind as never, rawResponseId: null }))
      ).rejects.toThrow(/raw response reference/);
    }
  });

  it("allows first-party kinds without a raw response reference", async () => {
    for (const kind of ["gsc_query", "vitals", "knowledge_fact", "research_finding"] as const) {
      const client = db();
      await expect(
        storeEvidenceRecord(client as never, base({ kind, rawResponseId: null }))
      ).resolves.toBeTruthy();
    }
  });

  it("rejects provider-collected evidence whose raw response has no recorded cost", async () => {
    const client = db({ costMicros: null as unknown as bigint });
    await expect(storeEvidenceRecord(client as never, base())).rejects.toThrow(/cost/);
  });

  it("never mixes provider and first-party metrics under one label", async () => {
    const client = db();
    await expect(
      storeEvidenceRecord(client as never, base({
        metrics: { position: { value: 7, unit: "rank", source: "provider" } },
      }))
    ).rejects.toThrow(/namespaced by its declared source/);
    await expect(
      storeEvidenceRecord(client as never, base({
        metrics: { "first_party:position": { value: 7, unit: "rank", source: "provider" } },
      }))
    ).rejects.toThrow(/namespaced by its declared source/);
    await expect(
      storeEvidenceRecord(client as never, base({
        metrics: { "provider:volume": { value: 500, unit: "searches/month", source: "first_party" } },
      }))
    ).rejects.toThrow(/namespaced by its declared source/);
  });

  it("rejects metrics without a declared unit", async () => {
    const client = db();
    await expect(
      storeEvidenceRecord(client as never, base({
        metrics: { "provider:volume": { value: 500, unit: "  ", source: "provider" } },
      }))
    ).rejects.toThrow(/must declare a unit/);
  });

  it("requires a producer and a valid observedAt (provenance)", async () => {
    const client = db();
    await expect(storeEvidenceRecord(client as never, base({ producer: "  " }))).rejects.toThrow(/producer/);
    await expect(
      storeEvidenceRecord(client as never, base({ observedAt: new Date("nope") }))
    ).rejects.toThrow(/observedAt/);
  });

  it("rejects unknown evidence kinds", async () => {
    const client = db();
    await expect(
      storeEvidenceRecord(client as never, base({ kind: "vibes" as never }))
    ).rejects.toThrow(/unknown evidence kind/);
  });

  it("is idempotent: the same input resolves to the same upsert identity", async () => {
    const client = db();
    await storeEvidenceRecord(client as never, base());
    await storeEvidenceRecord(client as never, base());
    const model = (client as unknown as { evidenceRecord: { upsert: ReturnType<typeof vi.fn> } }).evidenceRecord;
    expect(model.upsert).toHaveBeenCalledTimes(2);
    expect(model.upsert.mock.calls[0][0].where).toEqual(model.upsert.mock.calls[1][0].where);
  });

  it("uses an empty update so stored records are never silently mutated", async () => {
    const client = db();
    await storeEvidenceRecord(client as never, base());
    expect((client as unknown as { evidenceRecord: { upsert: ReturnType<typeof vi.fn> } }).evidenceRecord.upsert.mock.calls[0][0].update).toEqual({});
  });

  it("supersedes by writing a replacement and pointing the old row at it, never deleting", async () => {
    const client = db();
    await supersedeEvidenceRecord(client as never, "ev-old", base({ observedAt: new Date("2026-11-03T00:00:00.000Z") }));
    expect(client.evidenceRecord.update).toHaveBeenCalledWith({
      where: { id: "ev-old" },
      data: { supersededById: "ev1" },
    });
  });

  it("observation hash is sensitive to kind, dimensions and metrics", () => {
    const a = computeObservationHash(base());
    expect(computeObservationHash(base({ dimensions: { query: "other" } }))).not.toBe(a);
    expect(computeObservationHash(base({ metrics: { "provider:position": { value: 6, unit: "rank", source: "provider" } } }))).not.toBe(a);
    expect(computeObservationHash(base())).toBe(a); // order-insensitive
  });

  it("lists active evidence only (supersede, never delete)", async () => {
    const client = { evidenceRecord: { findMany: vi.fn().mockResolvedValue([]) }, rawProviderResponse: { findUnique: vi.fn() } };
    await listActiveEvidence(client as never, { projectId: "p1" });
    expect(client.evidenceRecord.findMany.mock.calls[0][0].where.supersededById).toBeNull();
    await listActiveEvidence(client as never, { projectId: "p1", activeOnly: false });
    expect(client.evidenceRecord.findMany.mock.calls[1][0].where.supersededById).toBeUndefined();
  });

  it("declares the full taxonomy of evidence kinds", () => {
    expect(EVIDENCE_KINDS).toHaveLength(19);
  });
});
