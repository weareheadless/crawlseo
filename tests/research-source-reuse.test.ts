import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  claims: new Map<string, { owner: string; leaseExpiresAt: Date }>(),
  identities: [] as Array<{ projectId: string; provider: string; normalizedUrl: string; currentHash: string | null; observations: Array<Record<string, unknown>> }>,
  creates: [] as Array<Record<string, unknown>>,
  sourceId: 0,
}));

vi.mock("@/lib/db", () => ({ db: {
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({
    researchSourceIdentity: {
      upsert: vi.fn(async ({ where, create, update }: { where: { projectId_provider_normalizedUrl: { projectId: string; provider: string; normalizedUrl: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const key = where.projectId_provider_normalizedUrl;
        let identity = state.identities.find((item) => item.projectId === key.projectId && item.provider === key.provider && item.normalizedUrl === key.normalizedUrl);
        if (!identity) { identity = { id: `identity-${state.identities.length + 1}`, ...create, observations: [] } as unknown as typeof state.identities[number]; state.identities.push(identity); }
        else Object.assign(identity, update);
        return identity;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const row = state.identities.find((item) => (item as unknown as { id: string }).id === where.id); if (row) Object.assign(row, data); }),
    },
    researchSource: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const observation = { id: `src-${++state.sourceId}`, ...data, retrievedAt: data.retrievedAt ?? new Date() };
        state.creates.push(observation);
        const identity = state.identities.find((item) => (item as unknown as { id: string }).id === data.identityId);
        identity?.observations.push(observation);
        return { id: observation.id, provider: data.provider, url: data.url, title: data.title, community: data.community, publishedAt: data.publishedAt, excerpt: data.excerpt, contentHash: data.contentHash };
      }),
    },
    researchRun: { update: vi.fn() },
  })),
  researchRun: { findUnique: vi.fn(async () => ({ id: "run", projectId: "p1" })) },
  researchDispatchClaim: {
    createMany: vi.fn(async ({ data }: { data: Array<{ projectId: string; provider: string; requestKey: string; owner: string; leaseExpiresAt: Date }> }) => {
      const row = data[0]!; const key = `${row.projectId}:${row.provider}:${row.requestKey}`;
      if (state.claims.has(key)) return { count: 0 };
      state.claims.set(key, { owner: row.owner, leaseExpiresAt: row.leaseExpiresAt }); return { count: 1 };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { projectId: string; provider: string; requestKey: string; owner?: string; leaseExpiresAt?: { lte: Date } }; data: { owner?: string; leaseExpiresAt: Date } }) => {
      const key = `${where.projectId}:${where.provider}:${where.requestKey}`; const current = state.claims.get(key);
      if (!current || (where.owner && where.owner !== current.owner) || (where.leaseExpiresAt && current.leaseExpiresAt > where.leaseExpiresAt.lte)) return { count: 0 };
      state.claims.set(key, { owner: data.owner ?? current.owner, leaseExpiresAt: data.leaseExpiresAt }); return { count: 1 };
    }),
  },
  researchSourceIdentity: { findMany: vi.fn(async ({ where }: { where: { projectId: string; provider: string } }) => state.identities.filter((identity) => identity.projectId === where.projectId && identity.provider === where.provider)) },
} }));

import { claimResearchDispatch, releaseResearchDispatch, reusableResearchSources, saveResearchSources } from "@/lib/research/service";

describe("project-scoped research reuse coordination", () => {
  beforeEach(() => { state.claims.clear(); state.identities = []; state.creates = []; state.sourceId = 0; vi.clearAllMocks(); });

  it("allows only one simultaneous database-backed dispatch claim", async () => {
    let dispatches = 0;
    const run = async () => {
      const owner = await claimResearchDispatch("p1", "reddit_rss", "same query");
      if (owner) dispatches += 1;
      return owner;
    };
    const owners = await Promise.all([run(), run()]);
    expect(owners.filter(Boolean)).toHaveLength(1);
    expect(dispatches).toBe(1);
  });

  it("does not reuse another project's observation", async () => {
    state.identities = [{ projectId: "p1", provider: "reddit_rss", normalizedUrl: "https://example.com/a", currentHash: "h1",
      observations: [{ provider: "reddit_rss", url: "https://example.com/a", contentHash: "h1", retrievedAt: new Date(), publishedAt: null, title: "t", excerpt: "e", language: null, metadata: { query: "topic" } }] }];
    expect(await reusableResearchSources({ projectId: "p2", provider: "reddit_rss", queries: ["topic"], recencyDays: 90, excludedDomains: [] })).toEqual([]);
  });

  it("does not reuse stale or excluded observations", async () => {
    state.identities = [
      { projectId: "p1", provider: "reddit_rss", normalizedUrl: "https://example.com/old", currentHash: "h1", observations: [
        { provider: "reddit_rss", url: "https://example.com/old", contentHash: "h1", retrievedAt: new Date("2020-01-01"), publishedAt: null, title: "t", excerpt: "e", language: null, metadata: { query: "topic" } },
      ] },
      { projectId: "p1", provider: "reddit_rss", normalizedUrl: "https://excluded.com/post", currentHash: "h2", observations: [
        { provider: "reddit_rss", url: "https://excluded.com/post", contentHash: "h2", retrievedAt: new Date(), publishedAt: null, title: "t", excerpt: "e", language: null, metadata: { query: "topic" } },
      ] },
    ];
    expect(await reusableResearchSources({ projectId: "p1", provider: "reddit_rss", queries: ["topic"], recencyDays: 30, excludedDomains: ["excluded.com"] })).toEqual([]);
  });

  it("releases an owned claim so a waiting retry can acquire it", async () => {
    const first = await claimResearchDispatch("p1", "news", "topic");
    expect(first).toBeTruthy();
    await releaseResearchDispatch("p1", "news", "topic", first!);
    expect(await claimResearchDispatch("p1", "news", "topic")).toBeTruthy();
  });

  it("creates a new immutable observation on changed content while retaining the previous mapping", async () => {
    const input = (contentHash: string) => [{ provider: "reddit_rss", url: "https://example.com/a?utm_source=x", title: "t", excerpt: contentHash, contentHash,
      metadata: { reddit_id: "source-1", query: "topic" } }];
    await saveResearchSources("run", input("hash-1"));
    await saveResearchSources("run", input("hash-2"));
    expect(state.identities).toHaveLength(1);
    expect(state.identities[0]?.currentHash).toBe("hash-2");
    expect(state.identities[0]?.observations.map((item) => item.contentHash)).toEqual(["hash-1", "hash-2"]);
  });
});
