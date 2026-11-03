import { describe, expect, it, vi } from "vitest";

import { matchKnowledgeFact, runJoinFollowUps, tokens } from "@/lib/funnel/join-runner";

const AT = new Date("2026-11-03T12:00:00.000Z");

const scoreInputs = {
  worth: { volume: 100, ctrAtPosition: 0.03, businessValue: 0.5 },
  winProbability: { rankDistance: 0.5, authorityGap: null, pageStrength: 0.5, serpCompetition: 0.5, playTypeFactor: 0.9 },
  effort: { playTypeBase: 2, sizeFactor: 1 },
  freshness: 1,
  stability: 0.8,
  evidenceCompleteness: "how",
};

function fakeDb(seed: {
  opportunities: Array<Record<string, unknown>>;
  facts?: Array<Record<string, unknown>>;
}) {
  const opportunities = seed.opportunities.map((row) => ({ ...row }));
  const edges: Array<Record<string, unknown>> = [];
  const db = {
    opportunity: {
      findMany: vi.fn(async (args?: { where?: { status?: { in?: string[] }; id?: { in?: string[] }; projectId?: string } }) =>
        opportunities.filter((row) => {
          const status = args?.where?.status?.in;
          if (status && !status.includes(String(row.status))) return false;
          const ids = args?.where?.id?.in;
          if (ids && !ids.includes(String(row.id))) return false;
          return true;
        })
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) => opportunities.find((row) => row.id === args.where.id) ?? null),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = opportunities.find((entry) => entry.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return { scoreValue: args.data.scoreValue ?? 0, evidenceCompleteness: args.data.evidenceCompleteness ?? "how" };
      }),
    },
    evidenceRecord: {
      findMany: vi.fn(async (args?: { where?: { kind?: string } }) =>
        (args?.where?.kind === "knowledge_fact" ? seed.facts ?? [] : [])
      ),
    },
    evidenceEdge: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        edges.push(args.create);
        return { id: `edge-${edges.length}` };
      }),
      count: vi.fn(async () => 1),
    },
    demandMapCluster: { findMany: vi.fn(async () => []) },
  };
  return { db: db as never, opportunities, edges };
}

const opportunity = (over: Record<string, unknown> = {}) => ({
  id: "opp-1",
  projectId: "p1",
  type: "O1_winnable_rank",
  title: 'Winnable rank: "abat-jour sur mesure" at position 6',
  summary: "A few ranks to win.",
  status: "detected",
  clusterId: null,
  evidenceCompleteness: "how",
  scoreInputs,
  scoreValue: 20,
  ...over,
});

const fact = (over: Record<string, unknown> = {}) => ({
  id: "fact-1",
  kind: "knowledge_fact",
  observedAt: AT,
  dimensions: { field: "services", value: "abat-jours sur mesure" },
  metrics: {},
  ...over,
});

describe("knowledge match for the why leg", () => {
  it("normalises accents and drops short/stop tokens", () => {
    expect([...tokens("Restauration d'abat-jour à Saint-Pierre")]).toEqual(["restauration", "abat", "jour", "saint", "pierre"]);
  });

  it("picks the fact with the most shared tokens", () => {
    const match = matchKnowledgeFact(
      { title: 'Winnable rank: "abat-jour sur mesure"', summary: null },
      [fact(), fact({ id: "fact-2", dimensions: { field: "voice", value: "chaleureux" } })]
    );
    expect(match?.fact.id).toBe("fact-1");
    // "abat-jour" and "abat-jours" share "abat" but not the singular/plural stem.
    expect(match?.shared).toEqual(["abat", "mesure"]);
  });

  it("does not guess when nothing is shared", () => {
    expect(matchKnowledgeFact({ title: "Missing sitemap", summary: null }, [fact()])).toBeNull();
  });
});

describe("join follow-up execution", () => {
  it("joins a missing why leg from business knowledge", async () => {
    const { db, opportunities, edges } = fakeDb({ opportunities: [opportunity()], facts: [fact()] });
    const result = await runJoinFollowUps(db, { projectId: "p1", now: AT });
    expect(result.joined).toHaveLength(1);
    expect(result.joined[0].leg).toBe("why");
    expect(edges).toHaveLength(1);
    expect(opportunities[0].evidenceCompleteness).toBe("both");
  });

  it("reports an unmatched why leg instead of attaching the wrong fact", async () => {
    const { db, opportunities } = fakeDb({
      opportunities: [opportunity({ title: "Missing h1 on https://x.com/" })],
      facts: [fact()],
    });
    const result = await runJoinFollowUps(db, { projectId: "p1", now: AT });
    expect(result.joined).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("no business fact");
    expect(opportunities[0].evidenceCompleteness).toBe("how");
  });

  it("runs the declared collection for a missing how leg and records its cost", async () => {
    const { db } = fakeDb({
      opportunities: [
        opportunity({
          id: "opp-13",
          type: "O13_user_pain_point",
          title: "User pain point without content: réparer un abat-jour",
          evidenceCompleteness: "why",
          status: "detected",
        }),
      ],
    });
    const collector = vi.fn(async () => ({
      evidence: [{ id: "ev-vol", kind: "keyword_metrics", observedAt: AT, dimensions: { query: "réparer un abat-jour" }, metrics: {} }],
      spentMicros: 120,
    }));
    const result = await runJoinFollowUps(db, {
      projectId: "p1",
      now: AT,
      maxSpendMicros: 1_000,
      collectors: { keywordMetrics: collector },
    });
    expect(collector).toHaveBeenCalledOnce();
    expect(result.joined[0].leg).toBe("how");
    expect(result.spentMicros).toBe(120);
  });

  it("does not spend when the ceiling is zero", async () => {
    const { db } = fakeDb({
      opportunities: [
        opportunity({ id: "opp-13", type: "O13_user_pain_point", title: "User pain point without content: abat-jour", evidenceCompleteness: "why" }),
      ],
    });
    const collector = vi.fn(async () => ({ evidence: [], spentMicros: 0 }));
    const result = await runJoinFollowUps(db, { projectId: "p1", now: AT, maxSpendMicros: 0, collectors: { keywordMetrics: collector } });
    expect(collector).not.toHaveBeenCalled();
    expect(result.skipped[0].reason).toBe("spend ceiling reached");
  });
});
