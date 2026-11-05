import { describe, expect, it, vi } from "vitest";

import {
  sealPacket,
  validateEvidenceRequest,
  type EvidencePacket,
} from "@/lib/recommendation/contracts";
import { loadInventory, type PacketDb } from "@/lib/recommendation/packet";

const at = new Date("2026-11-04T00:00:00.000Z");

function packet(): EvidencePacket {
  return sealPacket(
    {
      projectId: "p1",
      siteId: "s1",
      policyVersion: "recommendation-policy/2",
      candidate: {
        findingId: "f1",
        findingType: "CONCERN",
        theme: "warranty",
        summary: "Customers ask about warranty cover.",
        premise: null,
        observedAt: at.toISOString(),
        dedupKey: "O13:warranty",
        sourceIds: [],
      },
      businessFacts: [],
      context: { language: "en", audience: null, market: null, marketSource: null },
      sources: [],
      pages: [],
      links: [],
      requests: [],
      trace: [],
      inventory: [
        { url: "https://site.test/", title: "Home", status: 200, indexable: true, retrieval: "stored" },
        { url: "https://site.test/services", title: "Services", status: 200, indexable: true, retrieval: "stored" },
      ],
      search: [],
      limitations: [],
    },
    at
  );
}

describe("inventory completeness", () => {
  it("reads every known page in bounded batches instead of the first 500", async () => {
    const rows = Array.from({ length: 1_201 }, (_, index) => ({
      id: `id-${String(index).padStart(5, "0")}`,
      url: `https://site.test/page-${index}`,
      title: `Page ${index}`,
      contentText: `Body ${index}`,
      contentHash: `hash-${index}`,
      statusCode: 200,
      indexable: true,
    }));
    const db = {
      auditPage: {
        findMany: vi.fn(async (args: { cursor?: { id: string }; take: number }) => {
          const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor!.id) + 1 : 0;
          return rows.slice(start, start + args.take);
        }),
      },
    };
    const loaded = await loadInventory(db as unknown as PacketDb, "c1");
    expect(loaded).toHaveLength(1_201);
    expect(loaded.some((row) => row.url.endsWith("/page-1200"))).toBe(true);
  });

  it("finds an arbitrary page by title or body beyond the packet projection", () => {
    const request = {
      kind: "request_evidence" as const,
      requests: [
        {
          type: "inventory_search" as const,
          target: "warranty cover",
          question: "Which page explains warranty cover?",
          whyItMatters: "The answer decides whether an update is needed.",
        },
      ],
      rationale: "Find the page that may already answer the question.",
    };
    const result = validateEvidenceRequest(request, packet(), {
      siteDomain: "site.test",
      inventoryRows: [
        { url: "https://site.test/", title: "Home", contentText: null },
        { url: "https://site.test/services", title: "Services", contentText: null },
        {
          url: "https://site.test/p/abc123",
          title: "Aftercare",
          contentText: "Every installation includes a ten-year warranty covering parts and labour.",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.resolved[0]?.url).toBe("https://site.test/p/abc123");
  });
});
