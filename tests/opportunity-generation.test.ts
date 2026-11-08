import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-seo/writer", () => ({
  contentWriterConfig: () => ({ model: "test-model", apiKey: "test", baseUrl: "https://example.invalid" }),
}));
vi.mock("@/lib/ai/chat", () => ({
  chatJson: async () => {
    throw new Error("offline");
  },
}));

import {
  critiqueProposals,
  dedupeProposals,
  proposalScoreInputs,
  renderProposalBoard,
  storeProposals,
  validateProposal,
  type Proposal,
} from "@/lib/research/opportunity-generation";
import { proposalIdentity } from "@/lib/research/opportunity-drafting";
import type { TopicMap } from "@/lib/research/topic-map";

const domain = "atelier-harmonie.example";

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    dedupKey: "",
    lane: "content_business",
    kind: "update",
    title: "Enrichir la page luminaires",
    summary: "The hub ranks but the subcategory pages are thin.",
    whyNow: null,
    evidenceRefs: ["ev-1", "ev-2"],
    target: { url: "/lampes", newAsset: false, section: "hub" },
    action: "Expand the hub with buying guidance.",
    expectedOutcome: "More impressions on the format queries.",
    effort: "medium",
    confidence: null,
    confidenceReason: null,
    expiresAt: null,
    topicSlug: "luminaires",
    sources: [],
    critique: null,
    ...overrides,
  };
}

const map = {
  domain,
  month: "2026-11",
  locale: { language: "en", country: null },
  business: { name: null, services: [], location: null, serviceArea: [], audience: null, differentiators: [] },
  clusters: [],
  ai: { available: false },
} as unknown as TopicMap;

function topicCluster(overrides: Record<string, unknown> = {}) {
  return {
    slug: "luminaires",
    name: "Luminaires",
    kind: "market",
    topicSummary: "",
    intent: "commercial",
    relevance: "high",
    rationale: "",
    actionHint: "",
    marketScope: { scope: "international", markets: [], source: "offer" },
    confidence: 0.7,
    metrics: {
      queries: 1,
      impressions: 1_000,
      clicks: 20,
      volume: 500,
      volumeSum: 500,
      difficulty: null,
      position: 8,
      aeoQuestions: 0,
      aeoCited: 0,
    },
    queries: [],
    excludedQueries: [],
    pages: [],
    coverage: "strong",
    visibility: "proven",
    coverageFacts: { page: true, ranks: true, converts: true },
    language: "en",
    contextOnly: { queries: 0, impressions: 0, volume: 0, examples: [] },
    reviewFlags: [],
    gaps: [],
    ...overrides,
  };
}

describe("proposal identity", () => {
  it("is the asset, so a re-worded proposal updates the same row", () => {
    const first = makeProposal({ title: "Enrichir le hub", action: "Add guidance." });
    const second = makeProposal({ title: "Réécrire le hub luminaires", action: "Rewrite with a buying guide." });
    expect(proposalIdentity(first)).toBe(proposalIdentity(second));
  });

  it("keeps one row for a new page even when the invented slug moves", () => {
    const first = makeProposal({ kind: "article", target: { url: "/blog/art-et-tapisserie", newAsset: true, section: null } });
    const second = makeProposal({ kind: "article", target: { url: "/post/art-tapisserie", newAsset: true, section: null } });
    expect(proposalIdentity(first)).toBe(proposalIdentity(second));
  });

  it("separates different assets, lanes and no-page topics", () => {
    expect(proposalIdentity(makeProposal())).not.toBe(
      proposalIdentity(makeProposal({ target: { url: "/lampes/abat-jours", newAsset: false, section: null } }))
    );
    expect(proposalIdentity(makeProposal())).not.toBe(
      proposalIdentity(makeProposal({ lane: "aeo_geo", kind: "aeo" }))
    );
    expect(proposalIdentity(makeProposal({ target: { url: null, newAsset: true, section: null } }))).toBe(
      proposalIdentity(makeProposal({ target: { url: null, newAsset: true, section: null } }))
    );
  });

  it("deduplicates on the identity", () => {
    const proposals = [makeProposal({ dedupKey: "a" }), makeProposal({ dedupKey: "a" }), makeProposal({ dedupKey: "b" })];
    expect(dedupeProposals(proposals)).toHaveLength(2);
  });
});

describe("proposal validation", () => {
  it("accepts an unrated proposal and rejects a claim without a reason", () => {
    const evidenceIds = new Set(["ev-1", "ev-2"]);
    expect(validateProposal(makeProposal(), { domain, evidenceIds })).toBeNull();
    expect(
      validateProposal(makeProposal({ confidence: "high", confidenceReason: null }), { domain, evidenceIds })
    ).toMatch(/confidence needs a reason/);
  });

  it("requires first-party evidence for a high claim", () => {
    const evidenceIds = new Set(["ev-1", "ev-2", "provider-1"]);
    const firstParty = new Set(["ev-1"]);
    expect(
      validateProposal(
        makeProposal({ confidence: "high", confidenceReason: "GSC rows" }),
        { domain, evidenceIds, firstPartyEvidenceIds: firstParty }
      )
    ).toBeNull();
    expect(
      validateProposal(
        makeProposal({
          confidence: "high",
          confidenceReason: "provider volume",
          evidenceRefs: ["provider-1"],
        }),
        { domain, evidenceIds, firstPartyEvidenceIds: firstParty }
      )
    ).toMatch(/first-party evidence/);
  });

  it("rejects missing evidence, off-site targets and invalid timely items", () => {
    const evidenceIds = new Set(["ev-1", "ev-2"]);
    expect(
      validateProposal(makeProposal({ evidenceRefs: ["missing"] }), { domain, evidenceIds })
    ).toMatch(/unknown evidence/);
    expect(
      validateProposal(
        makeProposal({ target: { url: "https://other.example/page", newAsset: false, section: null } }),
        { domain, evidenceIds }
      )
    ).toMatch(/not on the site/);
    expect(
      validateProposal(
        makeProposal({ lane: "timely", whyNow: null, expiresAt: null }),
        { domain, evidenceIds }
      )
    ).toMatch(/whyNow/);
    expect(
      validateProposal(
        makeProposal({ target: { url: null, newAsset: false, section: null } }),
        { domain, evidenceIds }
      )
    ).toMatch(/needs a target/);
  });
});

describe("proposal critique", () => {
  it("flags a shared target as advice when the model is unavailable", async () => {
    const hub = makeProposal({ dedupKey: "hub" });
    const range = makeProposal({
      dedupKey: "range",
      kind: "business",
      title: "Opportunité gamme plafonniers",
      action: "Owner decision on the range.",
    });
    const result = await critiqueProposals([hub, range], map);
    expect(result.available).toBe(true);
    expect(result.model).toBe("deterministic");
    // Advice on the row, not a merge: both proposals stay on the board.
    expect(result.decisions.get("range")?.verdict).toBe("revise");
    expect(result.decisions.get("range")?.reason).toMatch(/Same target/);
  });

  it("keeps proposals on different assets independent", async () => {
    const result = await critiqueProposals(
      [
        makeProposal({ dedupKey: "hub" }),
        makeProposal({
          dedupKey: "aeo",
          lane: "aeo_geo",
          kind: "aeo",
          target: { url: "/lampes/abat-jours", newAsset: false, section: null },
        }),
      ],
      map
    );
    expect(result.decisions.get("aeo")?.reason ?? "").not.toMatch(/Same target/);
  });
});

describe("proposal storage", () => {
  it("reopens a parked proposal instead of treating it as closed", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      opportunity: {
        findUnique: async () => ({ id: "opp-parked", status: "parked", parkReason: "superseded by refreshed proposal" }),
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return { id: "opp-parked", status: "detected" };
        },
        create: async () => {
          throw new Error("must not create a second row for a parked proposal");
        },
      },
      evidenceEdge: {
        deleteMany: async () => ({ count: 0 }),
        upsert: async () => ({ id: "edge" }),
      },
    };
    await storeProposals(db as never, {
      projectId: "proj-1",
      siteId: "site-1",
      domain,
      map,
      topicMapRunId: "topic-run-1",
      proposals: [makeProposal({ dedupKey: "parked-key" })],
      evidenceIds: new Set(["ev-1", "ev-2"]),
      firstPartyEvidenceIds: new Set(["ev-1"]),
      knowledgeEvidenceIds: [],
      clusters: [],
    });
    expect(updates[0]).toEqual({ status: "detected", parkReason: null });
  });

  it("keeps a verified closure closed and reports the re-proposal", async () => {
    const db = {
      opportunity: {
        findUnique: async () => ({ id: "opp-closed", status: "closed", parkReason: null, evidenceCompleteness: "both" }),
        update: async () => ({ id: "opp-closed", status: "closed" }),
      },
      evidenceEdge: {
        deleteMany: async () => ({ count: 0 }),
        upsert: async () => ({ id: "edge" }),
      },
    };
    const result = await storeProposals(db as never, {
      projectId: "proj-1",
      siteId: "site-1",
      domain,
      map,
      topicMapRunId: "topic-run-1",
      proposals: [makeProposal({ dedupKey: "closed-key" })],
      evidenceIds: new Set(["ev-1", "ev-2"]),
      firstPartyEvidenceIds: new Set(["ev-1"]),
      knowledgeEvidenceIds: [],
      clusters: [],
    });
    expect(result.stored[0]).toMatchObject({ id: "opp-closed" });
    expect(result.reproposedClosed).toEqual([makeProposal().title]);
  });

  it("does not rewrite an accepted proposal when it is drafted again", async () => {
    let updated = 0;
    const db = {
      opportunity: {
        findUnique: async () => ({ id: "opp-accepted", status: "accepted", parkReason: null }),
        update: async () => {
          updated += 1;
          return { id: "opp-accepted", status: "accepted" };
        },
        create: async () => {
          throw new Error("must not create a second row for an accepted proposal");
        },
      },
      evidenceEdge: { upsert: async () => ({ id: "edge" }) },
    };
    const result = await storeProposals(db as never, {
      projectId: "proj-1",
      siteId: "site-1",
      domain,
      map,
      topicMapRunId: "topic-run-1",
      proposals: [makeProposal({ dedupKey: "accepted-key" })],
      evidenceIds: new Set(["ev-1", "ev-2"]),
      firstPartyEvidenceIds: new Set(["ev-1"]),
      knowledgeEvidenceIds: [],
      clusters: [],
    });
    expect(updated).toBe(0);
    expect(result.stored).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it("stores proposals and records evidence edges", async () => {
    const proposals = [makeProposal({ dedupKey: "hub" }), makeProposal({ dedupKey: "hub-2", target: { url: "/les-ateliers", newAsset: false, section: null } })];
    const evidenceIds = new Set(["ev-1", "ev-2"]);
    let created = 0;
    let edges = 0;
    const db = {
      opportunity: {
        findUnique: async () => null,
        create: async () => {
          created += 1;
          return { id: `opp-${created}`, status: "detected" };
        },
        update: async () => ({ id: "opp-1", status: "detected" }),
      },
      evidenceEdge: {
        upsert: async () => {
          edges += 1;
          return { id: `edge-${edges}` };
        },
      },
    };
    const result = await storeProposals(db as never, {
      projectId: "proj-1",
      siteId: "site-1",
      domain,
      map,
      topicMapRunId: "topic-run-1",
      proposals,
      evidenceIds,
      firstPartyEvidenceIds: evidenceIds,
      knowledgeEvidenceIds: [],
      clusters: [],
    });
    expect(result.dropped).toHaveLength(0);
    expect(result.stored).toHaveLength(2);
    expect(created).toBe(2);
    expect(edges).toBeGreaterThan(0);
  });
});

describe("proposal rendering", () => {
  it("shows an unrated confidence as not assessed instead of inventing one", () => {
    const board = renderProposalBoard({
      map,
      proposals: [makeProposal({ confidence: null })],
      dropped: [],
      critique: { available: false, model: null, summary: null, error: "none" },
      technical: [],
      generatedAt: "2026-11-05T00:00:00Z",
    });
    expect(board).toContain("confidence: not assessed");
  });

  it("declares the score inputs instead of hiding them", () => {
    const proposal = makeProposal();
    const score = proposalScoreInputs(proposal, null);
    expect(score.worth.change).toBe(proposal.action);
    expect(score.worth.successMeasure).toBe(proposal.expectedOutcome);
    expect(score.effort.playTypeBase).toBe(8);
  });

  it("puts foundations first and holds content when the site is invisible", () => {
    const invisible = {
      ...map,
      clusters: [topicCluster({ metrics: { ...topicCluster().metrics, impressions: 30, clicks: 0 } })],
    } as unknown as TopicMap;
    const board = renderProposalBoard({
      map: invisible,
      proposals: [
        makeProposal({ title: "Write the luminaire page", topicSlug: "luminaires" }),
        makeProposal({
          lane: "technical",
          kind: "technical",
          title: "Fix the sitemap",
          target: { url: "/", newAsset: false, section: null },
          topicSlug: null,
        }),
      ],
      dropped: [],
      critique: { available: false, model: null, summary: null, error: "none" },
      technical: [],
      generatedAt: "2026-11-05T00:00:00Z",
    });
    expect(board).toContain("Foundations first");
    expect(board).toContain("HOLD");
    expect(board.indexOf("Fix the sitemap")).toBeLessThan(board.indexOf("Write the luminaire page"));
  });

  it("says a proposal is no longer proposed, not closed", () => {
    const board = renderProposalBoard({
      map,
      proposals: [makeProposal()],
      dropped: [],
      critique: { available: false, model: null, summary: null, error: "none" },
      changes: { updated: 1, added: [], noLongerProposed: ["Fix the old sitemap"] },
      technical: [],
      generatedAt: "2026-11-05T00:00:00Z",
    });
    expect(board).toContain("1 no longer proposed");
    expect(board).toContain("- no longer proposed: Fix the old sitemap");
    expect(board).not.toContain(" closed.");
  });

  it("scores a measured topic and flags a language mismatch", () => {
    const spanish = {
      ...map,
      clusters: [topicCluster({ language: "es" })],
    } as unknown as TopicMap;
    const board = renderProposalBoard({
      map: spanish,
      proposals: [makeProposal()],
      dropped: [],
      critique: { available: false, model: null, summary: null, error: "none" },
      technical: [],
      generatedAt: "2026-11-05T00:00:00Z",
    });
    expect(board).toContain("clicks/month at the measured position");
    expect(board).toContain("queries are in es; the site locale is en");
  });
});
