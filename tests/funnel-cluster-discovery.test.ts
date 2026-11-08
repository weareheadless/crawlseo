import { describe, expect, it, vi } from "vitest";

import {
  DISCOVERY_THRESHOLDS,
  discoverClusters,
  jaccard,
  normalizeQuery,
  proposeCompetitorClusters,
  proposeKnowledgeClusters,
  proposeLexicalClusters,
  proposeSerpClusters,
  reconcileClusters,
  significantTokens,
  type ClusterProposal,
} from "@/lib/funnel/cluster-discovery";

const AT = new Date("2026-11-01T00:00:00.000Z");

const q = (query: string) => ({ query, observedAt: AT });

describe("cluster discovery: normalisation", () => {
  it("strips accents, punctuation and case", () => {
    expect(normalizeQuery("  ¿Buceo en Playa del Carmen? ")).toBe("buceo en playa del carmen");
  });

  it("drops stopwords, short tokens and bare numbers", () => {
    expect(significantTokens("how to choose a freediving course in 2026")).toEqual(["choose", "freediving", "course"]);
    expect(significantTokens("curso de buceo en playa")).toEqual(["curso", "buceo", "playa"]);
  });

  it("computes jaccard overlap", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(1);
  });
});

describe("cluster discovery: lexical signal", () => {
  it("groups queries that share a significant phrase", () => {
    const proposals = proposeLexicalClusters([
      q("freediving course playa del carmen"),
      q("freediving course bacalar"),
      q("freediving course price"),
      q("scuba diving tulum"),
    ]);
    const freediving = proposals.find((proposal) => proposal.name.includes("freediving course"));
    expect(freediving).toBeTruthy();
    expect(freediving!.members).toContain("freediving course bacalar");
    expect(freediving!.members).not.toContain("scuba diving tulum");
  });

  it("merges overlapping phrases into one component instead of two clusters", () => {
    const proposals = proposeLexicalClusters([
      q("freediving course playa del carmen"),
      q("freediving course bacalar"),
      q("course playa del carmen price"),
    ]);
    const withMembers = proposals.filter((proposal) => proposal.members.length >= 3);
    expect(withMembers.length).toBeGreaterThan(0);
    // The three queries must not be split across two three-member clusters.
    expect(proposals.filter((p) => p.members.length === 3).length).toBeLessThanOrEqual(1);
  });

  it("respects the minimum member threshold", () => {
    const proposals = proposeLexicalClusters([q("lonely phrase here"), q("another topic entirely")]);
    expect(proposals).toHaveLength(0);
  });

  it("derives a stable identity from the shared phrase, not a generated name", () => {
    const a = proposeLexicalClusters([q("freediving course playa"), q("freediving course bacalar")]);
    const b = proposeLexicalClusters([q("freediving course playa"), q("freediving course bacalar"), q("freediving course tulum")]);
    expect(a[0].identityKey.startsWith("lexical:")).toBe(true);
    expect(a[0].identityKey).toBe("lexical:freediving course");
    expect(b.some((proposal) => proposal.identityKey === a[0].identityKey)).toBe(true);
  });

  it("infers intent from the query wording", () => {
    const price = proposeLexicalClusters([q("freediving course price"), q("freediving course price list")]);
    expect(price[0].intent).toBe("transactional");
    const local = proposeLexicalClusters([q("freediving course near me"), q("freediving course near me cheap")]);
    expect(local[0].intent).toBe("local");
  });
});

describe("cluster discovery: SERP overlap signal", () => {
  const snap = (query: string, urls: string[]) => ({ query, urls, observedAt: AT });

  it("groups queries whose top results overlap", () => {
    const proposals = proposeSerpClusters([
      snap("freediving course", ["a", "b", "c", "d"]),
      snap("freediving class", ["a", "b", "c", "e"]),
      snap("boat engine repair", ["x", "y", "z", "w"]),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].members).toEqual(expect.arrayContaining(["freediving course", "freediving class"]));
    expect(proposals[0].members).not.toContain("boat engine repair");
  });

  it("prefers SERP overlap and records it as the proposing signal", () => {
    const proposals = proposeSerpClusters([
      snap("freediving course", ["a", "b"]),
      snap("freediving class", ["a", "b"]),
    ]);
    expect(proposals[0].proposedBy).toBe("serp_overlap");
    expect(proposals[0].identityKey.startsWith("serp:")).toBe(true);
  });

  it("ignores snapshots without URLs", () => {
    expect(proposeSerpClusters([snap("a b", []), snap("c d", [])])).toHaveLength(0);
  });
});

describe("cluster discovery: knowledge prior", () => {
  it("proposes one cluster per question with a hashed identity", () => {
    const proposals = proposeKnowledgeClusters([{ question: "How much does a freediving course cost?", observedAt: AT }]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].identityKey.startsWith("knowledge:")).toBe(true);
    expect(proposals[0].members).toHaveLength(1);
    expect(proposals[0].proposedBy).toBe("knowledge_prior");
  });
});

/** Minimal in-memory stand-in for the two tables reconciliation touches. */
function fakeDb() {
  const clusters: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  let counter = 0;
  const db = {
    demandMapCluster: {
      findMany: vi.fn(async (args: { where: { projectId: string; supersededAt?: null } }) =>
        clusters.filter(
          (row) =>
            row.projectId === args.where.projectId &&
            (args.where.supersededAt === undefined || row.supersededAt == null)
        )
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const data = args.data;
        // Mirror the table's unique keys so a collision fails the test the way
        // the database fails the monthly cycle.
        if (clusters.some((row) => row.projectId === data.projectId && row.slug === data.slug)) {
          throw new Error("Unique constraint failed on the fields: (`projectId`,`slug`)");
        }
        if (clusters.some((row) => row.projectId === data.projectId && row.identityKey === data.identityKey)) {
          throw new Error("Unique constraint failed on the fields: (`projectId`,`identityKey`)");
        }
        counter += 1;
        const row = { id: `c-${counter}`, supersededAt: null, supersededById: null, ...data };
        clusters.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = clusters.find((entry) => entry.id === args.where.id)!;
        Object.assign(row, args.data);
        return row;
      }),
    },
    evidenceRecord: {
      findMany: vi.fn(async (args: { where: { kind: string } }) => {
        if (args.where.kind === "keyword_universe_membership") return evidence;
        return [];
      }),
      upsert: vi.fn(async (args: { create: Record<string, unknown>; where: Record<string, unknown> }) => {
        const key = JSON.stringify(args.where);
        const existing = evidence.find((row) => JSON.stringify({ projectId_kind_observationHash: {
          projectId: row.projectId, kind: row.kind, observationHash: row.observationHash,
        } }) === key);
        if (existing) return { id: existing.id };
        const row = { id: `e-${evidence.length + 1}`, ...args.create };
        evidence.push(row);
        return { id: row.id };
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    evidenceEdge: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn() },
    keyword: { findMany: vi.fn().mockResolvedValue([]) },
    rawProviderResponse: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return { db: db as never, clusters, evidence };
}

const proposal = (over: Partial<ClusterProposal> = {}): ClusterProposal => ({
  identityKey: "lexical:freediving course",
  name: "freediving course",
  topicSummary: "2 queries sharing the phrase “freediving course”.",
  intent: "commercial",
  proposedBy: "gsc_query",
  confidence: 0.4,
  members: ["freediving course playa", "freediving course bacalar"],
  observedAt: AT,
  ...over,
});

describe("cluster discovery: competitor ownership signal", () => {
  const row = (query: string, competitors: string[], ourPosition: number | null) => ({ query, competitors, ourPosition, observedAt: AT });

  it("groups queries competitors own and we do not rank for", () => {
    const proposals = proposeCompetitorClusters([
      row("freediving course", ["rival-a", "rival-b"], null),
      row("freediving class", ["rival-a", "rival-b"], null),
      row("boat engine", ["other"], null),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposedBy).toBe("competitor_ownership");
    expect(proposals[0].members).toHaveLength(2);
    expect(proposals[0].identityKey.startsWith("competitor:")).toBe(true);
  });

  it("ignores queries where we already rank", () => {
    const proposals = proposeCompetitorClusters([
      row("freediving course", ["rival-a"], 4),
      row("freediving class", ["rival-a"], 9),
    ]);
    expect(proposals).toHaveLength(0);
  });

  it("needs at least two queries behind the same rival set", () => {
    expect(proposeCompetitorClusters([row("lonely query", ["rival-a"], null)])).toHaveLength(0);
  });
});

describe("cluster reconciliation", () => {
  it("creates a cluster and its membership evidence", async () => {
    const { db, clusters, evidence } = fakeDb();
    const result = await reconcileClusters(db, "p1", [proposal()]);
    expect(result.created).toBe(1);
    expect(clusters).toHaveLength(1);
    expect(result.memberships).toBe(2);
    expect(evidence).toHaveLength(2);
  });

  it("never endorses a discovered cluster", async () => {
    const { db, clusters } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    const relevance = clusters[0].businessRelevance as { relevance: string; decidedBy?: string };
    expect(relevance.relevance).toBe("none");
    expect(relevance.decidedBy).toBeUndefined();
    expect(clusters[0].proposedBy).toBe("gsc_query");
  });

  it("is idempotent: the same proposal twice creates no duplicate cluster or membership", async () => {
    const { db, clusters, evidence } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    const membershipsAfterFirst = evidence.length;
    const second = await reconcileClusters(db, "p1", [proposal()]);
    expect(second.created).toBe(0);
    expect(clusters).toHaveLength(1);
    expect(evidence).toHaveLength(membershipsAfterFirst);
  });

  it("merges a differently named proposal that shares its members", async () => {
    const { db, clusters } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    const renamed = await reconcileClusters(db, "p1", [
      proposal({ identityKey: "lexical:freediving class", name: "freediving class" }),
    ]);
    expect(renamed.created).toBe(0);
    expect(renamed.merged).toBe(1);
    expect(clusters).toHaveLength(1);
  });

  it("creates a separate cluster when members barely overlap", async () => {
    const { db, clusters } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    const other = await reconcileClusters(db, "p1", [
      proposal({
        identityKey: "lexical:boat engine",
        name: "boat engine",
        members: ["boat engine repair", "boat engine parts"],
      }),
    ]);
    expect(other.created).toBe(1);
    expect(clusters).toHaveLength(2);
  });

  it("supersedes a cluster that no longer receives members, without deleting it", async () => {
    const { db, clusters } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    const second = await reconcileClusters(db, "p1", [
      proposal({
        identityKey: "lexical:boat engine",
        name: "boat engine",
        members: ["boat engine repair", "boat engine parts"],
      }),
    ]);
    expect(second.superseded).toBe(1);
    expect(clusters).toHaveLength(2);
    const retired = clusters.find((row) => row.supersededAt != null);
    expect(retired).toBeTruthy();
    // Retired, not deleted, and never a self-reference.
    expect(retired!.supersededById).not.toBe(retired!.id);
  });

  it("revives a retired cluster when its stable identity returns", async () => {
    const { db, clusters } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    await reconcileClusters(db, "p1", [
      proposal({
        identityKey: "lexical:boat engine",
        name: "boat engine",
        members: ["boat engine repair", "boat engine parts"],
      }),
    ]);
    expect(clusters.find((row) => row.identityKey === "lexical:freediving course")?.supersededAt).not.toBeNull();

    const again = await reconcileClusters(db, "p1", [proposal()]);
    expect(again.created).toBe(0);
    expect(again.revived).toBe(1);
    const matching = clusters.filter((row) => row.identityKey === "lexical:freediving course");
    expect(matching).toHaveLength(1);
    expect(matching[0].supersededAt).toBeNull();
    expect(matching[0].supersededById).toBeNull();
  });

  it("keeps a human relevance decision when reviving a retired cluster", async () => {
    const { db, clusters } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    const first = clusters.find((row) => row.identityKey === "lexical:freediving course")!;
    first.businessRelevance = { relevance: "core", decidedBy: "human" };
    await reconcileClusters(db, "p1", [
      proposal({
        identityKey: "lexical:boat engine",
        name: "boat engine",
        members: ["boat engine repair", "boat engine parts"],
      }),
    ]);

    await reconcileClusters(db, "p1", [proposal()]);
    expect(clusters.find((row) => row.identityKey === "lexical:freediving course")?.businessRelevance).toEqual({
      relevance: "core",
      decidedBy: "human",
    });
  });

  it("gives a new identity a fresh slug when a retired cluster owns the name", async () => {
    const { db, clusters } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    await reconcileClusters(db, "p1", [
      proposal({
        identityKey: "lexical:boat engine",
        name: "boat engine",
        members: ["boat engine repair", "boat engine parts"],
      }),
    ]);

    const again = await reconcileClusters(db, "p1", [
      proposal({ identityKey: "serp:freediving-course", members: ["other a", "other b"] }),
    ]);
    expect(again.created).toBe(1);
    const slugs = clusters.map((row) => row.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain("freediving-course-2");
  });

  it("keeps a curated cluster with no members instead of superseding it", async () => {
    const { db, clusters } = fakeDb();
    const client = db as unknown as { demandMapCluster: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } };
    await client.demandMapCluster.create({
      data: { projectId: "p1", slug: "curated", identityKey: "curated:curated", name: "Curated", topicSummary: "t", intent: "mixed", businessRelevance: {}, proposedBy: "manual", confidence: 0 },
    });
    const result = await reconcileClusters(db, "p1", [proposal()]);
    expect(result.superseded).toBe(0);
    expect(clusters.find((row) => row.slug === "curated")?.supersededAt).toBeNull();
  });

  it("gives two clusters with the same name distinct slugs", async () => {
    const { db, clusters } = fakeDb();
    await reconcileClusters(db, "p1", [proposal()]);
    await reconcileClusters(db, "p1", [
      proposal({ identityKey: "serp:other", name: "freediving course", members: ["other a", "other b"] }),
    ]);
    const slugs = clusters.map((row) => row.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("exposes the declared thresholds", () => {
    expect(DISCOVERY_THRESHOLDS.minMembers).toBeGreaterThan(1);
    expect(DISCOVERY_THRESHOLDS.mergeThreshold).toBeGreaterThan(0);
    expect(DISCOVERY_THRESHOLDS.serpOverlapThreshold).toBeGreaterThan(0);
  });
});

describe("discoverClusters end to end (stored evidence only)", () => {
  it("never touches a provider or raw-payload store", async () => {
    const { db } = fakeDb();
    const probes = { rawProviderResponse: { findUnique: vi.fn(), findMany: vi.fn() }, keyword: { findMany: vi.fn().mockResolvedValue([]) } };
    const client = { ...(db as unknown as Record<string, unknown>), ...probes } as never;
    await discoverClusters(client, "p1");
    // Discovery reads the evidence store only: no raw provider payload, no paid table.
    expect(probes.rawProviderResponse.findUnique).not.toHaveBeenCalled();
    expect(probes.rawProviderResponse.findMany).not.toHaveBeenCalled();
  });

  it("reads rank evidence and produces clusters without any provider call", async () => {
    const { db, clusters } = fakeDb();
    const withRanks = {
      ...(db as unknown as Record<string, unknown>),
      evidenceRecord: {
        ...(db as unknown as { evidenceRecord: Record<string, unknown> }).evidenceRecord,
        findMany: vi.fn(async (args: { where: { kind: string } }) => {
          if (args.where.kind === "keyword_rank") {
            return [
              { dimensions: { query: "freediving course playa" }, observedAt: AT },
              { dimensions: { query: "freediving course bacalar" }, observedAt: AT },
              { dimensions: { query: "freediving course tulum" }, observedAt: AT },
            ];
          }
          return [];
        }),
      },
    } as never;

    const result = await discoverClusters(withRanks, "p1");
    expect(result.proposals).toBeGreaterThan(0);
    expect(clusters.length).toBeGreaterThan(0);
    expect((db as unknown as { keyword: { findMany: ReturnType<typeof vi.fn> } }).keyword.findMany).not.toHaveBeenCalled();
  });
});
