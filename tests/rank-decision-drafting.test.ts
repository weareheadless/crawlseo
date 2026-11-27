import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-seo/writer", () => ({
  contentWriterConfig: vi.fn(() => ({ model: "test-model", apiKey: "test", baseUrl: "https://example.invalid" })),
}));
vi.mock("@/lib/ai/chat", () => ({
  chatJson: async () => {
    throw new Error("the real chatJson must never be called from this test");
  },
}));

import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { parseOpportunityProposal } from "@/lib/funnel/proposal";
import {
  draftRankDecisions,
  RANK_DECISION_TYPES,
  RANK_DRAFTING_PROMPT_VERSION,
} from "@/lib/research/rank-decision-drafting";

const PAGE_URL = "https://atelier.example/product-page/abat-jour-pagode";
const O2_KEY = `O2:abat jour pagode:${PAGE_URL}`;

const rankEvidence = {
  id: "ev-rank-1",
  kind: "keyword_rank",
  dimensions: { query: "abat jour pagode", url: PAGE_URL, windowDays: 28, cluster: "abat-jours" },
  metrics: {
    "first_party:position": { value: 14 },
    "first_party:impressions": { value: 120 },
    "first_party:clicks": { value: 0 },
    "first_party:ctr": { value: 0 },
  },
};

const competitorEvidence = {
  id: "ev-comp-1",
  kind: "competitor_rank",
  // A folded variant of the row's query: the match is case/accent/whitespace only.
  dimensions: { query: "Abat Jour  Pagode", domain: "deco.example", rankAbsolute: 5 },
  metrics: {},
};

const knowledgeEvidence = { id: "ev-know-1", kind: "knowledge_fact", dimensions: {}, metrics: {} };

function opportunityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "opp-1",
    type: "O2_striking_distance",
    dedupKey: O2_KEY,
    title: 'Striking distance: "abat jour pagode" gets impressions, no clicks',
    summary: "Position 14 with 120 impressions and low CTR — the snippet is not earning the click.",
    scoreInputs: { worth: { targetPosition: 10, volume: 120 } },
    recommendationDecision: null,
    scoreValue: 10,
    ...overrides,
  };
}

function validDecision(overrides: Record<string, unknown> = {}) {
  return {
    dedupKey: O2_KEY,
    propose: true,
    readiness: "actionable",
    title: "Réécrire le title et la meta description de la page pagode",
    summary: "La page se classe 14e pour « abat jour pagode » sans gagner un clic.",
    action:
      "Réécrire le title et la meta description en nommant « abat-jour pagode » et la pièce d'atelier, pour distinguer la page de deco.example en 5e position.",
    expectedOutcome: "Des clics sur une position déjà acquise.",
    effort: "small",
    confidence: "medium",
    confidenceReason: "La fenêtre est mesurée et le snippet actuel est générique.",
    evidenceIds: ["ev-rank-1"],
    ...overrides,
  };
}

function makeDb(rows: Array<Record<string, unknown>> = [opportunityRow()]) {
  const state = {
    opportunityWhere: [] as unknown[],
    updates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    edgeWhere: [] as unknown[],
  };
  const db = {
    site: {
      findUnique: async () => ({ id: "site-1", domain: "atelier.example", projectId: "proj-1", retiredAt: null }),
    },
    siteProfile: {
      findUnique: async () => ({ language: "fr", topics: [], audience: null, constraints: { market: "France" } }),
    },
    businessKnowledgeDocument: {
      findUnique: async () => ({
        revision: 1,
        acceptedRevision: 1,
        revisions: [
          {
            revision: 1,
            fields: {
              businessName: { value: "Atelier de l'harmonie" },
              services: { value: ["Restauration d'abat-jour"] },
              location: { value: "Saint-Pierre-en-Port, France" },
              serviceArea: { value: ["Normandie"] },
            },
          },
        ],
      }),
    },
    opportunity: {
      findMany: async ({ where }: { where: unknown }) => {
        state.opportunityWhere.push(where);
        return rows;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.updates.push({ where, data });
        return { count: 1 };
      },
    },
    evidenceEdge: {
      findMany: async ({ where }: { where: unknown }) => {
        state.edgeWhere.push(where);
        return [{ toId: "opp-1", fromType: "evidence_record", fromId: "ev-rank-1", relation: "supporting" }];
      },
    },
    evidenceRecord: {
      findMany: async ({ where, take }: { where: Record<string, never>; take?: number }) => {
        if (where.kind === "knowledge_fact") return [knowledgeEvidence].slice(0, take ?? 4);
        if (where.kind === "competitor_rank") return [competitorEvidence];
        const ids = (where.id as { in?: string[] } | undefined)?.in;
        if (ids) return [rankEvidence, competitorEvidence, knowledgeEvidence].filter((row) => ids.includes(row.id));
        return [];
      },
    },
    crawl: {
      findFirst: async () => ({ id: "crawl-1" }),
    },
    auditPage: {
      findMany: async () => [
        {
          url: PAGE_URL,
          title: "Abat-jour pagode vermillon | Atelier",
          description: "Un abat-jour pagode vermillon.",
          h1s: ["Abat-jour pagode vermillon"],
          wordCount: 420,
          contentText: "Restauration pièce par pièce dans l'atelier de Saint-Pierre-en-Port.",
        },
      ],
    },
  };
  return { db, state };
}

type ChatCall = { system: string; user: string };

function makeChat(respond: (call: number, payload: Record<string, unknown>) => unknown) {
  const calls: ChatCall[] = [];
  const chat = async (input: { system: string; user: string }) => {
    calls.push({ system: input.system, user: input.user });
    return respond(calls.length, JSON.parse(input.user));
  };
  return { chat: chat as never, calls };
}

describe("rank decision drafting", () => {
  it("drafts a validated phase3-v1 decision and stores it on the row", async () => {
    const { db, state } = makeDb();
    const { chat, calls } = makeChat(() => ({ summary: "one play", decisions: [validDecision()] }));

    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });

    expect(result.status).toBe("completed");
    expect(result.considered).toBe(1);
    expect(result.drafted).toBe(1);
    expect(result.stored).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(result.declined).toEqual([]);

    // The payload carries the assembled facts: the crawl page, the measured
    // window, the folded-query competitor above us and the citable catalogue.
    const payload = JSON.parse(calls[0].user);
    expect(payload.business.name).toBe("Atelier de l'harmonie");
    expect(payload.locale.language).toBe("fr");
    const row = payload.rows[0];
    expect(row.dedupKey).toBe(O2_KEY);
    expect(row.page.title).toBe("Abat-jour pagode vermillon | Atelier");
    expect(row.page.description).toBe("Un abat-jour pagode vermillon.");
    expect(row.rank).toMatchObject({ position: 14, impressions: 120, clicks: 0, windowDays: 28, targetPosition: 10 });
    expect(row.competitorsAbove).toEqual([{ domain: "deco.example", position: 5, evidenceId: "ev-comp-1" }]);
    expect(row.evidence.map((entry: { id: string }) => entry.id).sort()).toEqual([
      "ev-comp-1",
      "ev-know-1",
      "ev-rank-1",
    ]);

    // The stored decision satisfies the one contract the board and the
    // acceptance gate share, with the lane facts fixed by code.
    expect(state.updates).toHaveLength(1);
    const stored = state.updates[0].data.recommendationDecision;
    const proposal = parseOpportunityProposal(stored);
    expect(proposal).not.toBeNull();
    expect(proposal!.source).toBe("phase3-rank-drafting");
    expect(proposal!.lane).toBe("content_business");
    expect(proposal!.kind).toBe("update");
    expect(proposal!.readiness).toBe("actionable");
    expect(proposal!.target).toEqual({ url: PAGE_URL, newAsset: false, section: null });
    expect(proposal!.evidenceRefs).toEqual(["ev-rank-1"]);
    expect((stored as Record<string, unknown>).promptVersion).toBe(RANK_DRAFTING_PROMPT_VERSION);
    expect((stored as Record<string, unknown>).model).toBe("test-model");
    expect(state.updates[0].data.recommendationVersion).toBe("phase3-v1");
    expect(state.updates[0].data.recommendationEvidenceId).toBe("ev-rank-1");
    expect(state.updates[0].data.recommendationFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("only asks for detected rows of the drafted types", async () => {
    const { db, state } = makeDb([]);
    const { chat } = makeChat(() => ({ summary: "", decisions: [] }));
    await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(state.opportunityWhere[0]).toMatchObject({
      projectId: "proj-1",
      status: "detected",
      type: { in: [...RANK_DECISION_TYPES] },
    });
  });

  it("leaves a row that already carries a decision alone", async () => {
    const { db, state } = makeDb([opportunityRow({ recommendationDecision: { schemaVersion: "phase3-v1" } })]);
    const { chat, calls } = makeChat(() => ({ summary: "", decisions: [validDecision()] }));
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(result.considered).toBe(0);
    expect(calls).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("records a decline without writing anything", async () => {
    const { db, state } = makeDb();
    const { chat } = makeChat(() => ({
      summary: "",
      decisions: [{ dedupKey: O2_KEY, propose: false, reason: "the query intent does not match the offer" }],
    }));
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(result.declined).toEqual([{ dedupKey: O2_KEY, reason: "the query intent does not match the offer" }]);
    expect(result.drafted).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it("re-proposes once with the failure reason, then stores the corrected decision", async () => {
    const { db, state } = makeDb();
    const { chat, calls } = makeChat((call) =>
      call === 1
        ? { summary: "", decisions: [validDecision({ evidenceIds: ["ev-fabricated"] })] }
        : { summary: "", decisions: [validDecision()] }
    );
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(calls).toHaveLength(2);
    expect(calls[1].system).toMatch(/second attempt/i);
    const retryPayload = JSON.parse(calls[1].user);
    expect(retryPayload.rows[0].previousFailure).toMatch(/not in the row's catalogue/);
    expect(result.stored).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(state.updates).toHaveLength(1);
  });

  it("leaves a row undecided when it fails the contract twice", async () => {
    const { db, state } = makeDb();
    const { chat, calls } = makeChat(() => ({ summary: "", decisions: [validDecision({ action: "   " })] }));
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(calls).toHaveLength(2);
    expect(result.stored).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/required/);
    expect(state.updates).toHaveLength(0);
  });

  it("rejects a decision that does not cite the row's rank observation", async () => {
    const { db } = makeDb();
    const { chat } = makeChat(() => ({
      summary: "",
      decisions: [validDecision({ evidenceIds: ["ev-know-1"] })],
    }));
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(result.stored).toBe(0);
    expect(result.rejected[0].reason).toMatch(/rank observation/);
  });

  it("dry-runs the whole pass without a single write", async () => {
    const { db, state } = makeDb();
    const { chat } = makeChat(() => ({ summary: "", decisions: [validDecision()] }));
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "dry-run", chat });
    expect(result.drafted).toBe(1);
    expect(result.stored).toBe(0);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].title).toMatch(/Réécrire/);
    expect(state.updates).toHaveLength(0);
  });

  it("reports a missing writer key instead of drafting", async () => {
    vi.mocked(contentWriterConfig).mockReturnValueOnce(null);
    const { db, state } = makeDb();
    const { chat, calls } = makeChat(() => ({ summary: "", decisions: [] }));
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(result.status).toBe("failed");
    expect(result.errors.join()).toMatch(/CONTENT_LLM_API_KEY/);
    expect(calls).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("skips a row whose own record resolves no anchor, rather than guessing one", async () => {
    const { db, state } = makeDb([opportunityRow({ dedupKey: "O2:abat jour pagode:" })]);
    const { chat, calls } = makeChat(() => ({ summary: "", decisions: [validDecision()] }));
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(result.skipped).toEqual([
      { dedupKey: "O2:abat jour pagode:", reason: "row resolves no page/query anchor from its own record" },
    ]);
    expect(calls).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("bounds the run and reports the rows it did not send", async () => {
    const rows = Array.from({ length: 49 }, (_, index) =>
      opportunityRow({
        id: `opp-${index}`,
        dedupKey: `O2:query numero ${index}:https://atelier.example/page-${index}`,
      })
    );
    const { db } = makeDb(rows);
    const { chat, calls } = makeChat(() => ({ summary: "", decisions: [] }));
    const result = await draftRankDecisions(db as never, { siteId: "site-1", mode: "execute", chat });
    expect(result.considered).toBe(49);
    expect(result.truncations.join()).toMatch(/1 open rows were not drafted: per-run bound is 48/);
    // 48 sent in batches of 6, each batch allowed its single re-proposal.
    expect(calls).toHaveLength(16);
    expect(result.rejected).toHaveLength(48);
  });
});

describe("proposal source contract", () => {
  const base = {
    schemaVersion: "phase3-v1",
    lane: "content_business",
    kind: "update",
    readiness: "actionable",
    title: "t",
    summary: "s",
    target: { url: PAGE_URL, newAsset: false },
    action: "a",
    expectedOutcome: "o",
    effort: "small",
  };

  it("accepts both drafting pipelines that speak phase3-v1", () => {
    expect(parseOpportunityProposal({ ...base, source: "phase3-topic-map" })?.source).toBe("phase3-topic-map");
    expect(parseOpportunityProposal({ ...base, source: "phase3-rank-drafting" })?.source).toBe("phase3-rank-drafting");
  });

  it("rejects an unknown source", () => {
    expect(parseOpportunityProposal({ ...base, source: "something-else" })).toBeNull();
    expect(parseOpportunityProposal({ ...base })).toBeNull();
  });
});
