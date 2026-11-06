import { describe, expect, it, vi } from "vitest";

const { stored } = vi.hoisted(() => ({ stored: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/funnel/evidence", () => ({
  storeEvidenceRecord: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    stored.push(input);
    return { id: `e-${stored.length}` };
  }),
}));

import { bridgeQuestionCoverageToEvidence } from "@/lib/research/question-coverage-evidence";

function db(overrides: { keywords?: unknown[]; language?: string } = {}) {
  const metrics = overrides.keywords ?? [
    { dimensions: { query: "freediving course" }, metrics: { "provider:volume": { value: 1300 } } },
    { dimensions: { query: "freediving course price" }, metrics: { "provider:volume": { value: 300 } } },
  ];
  return {
    businessKnowledgeDocument: {
      findUnique: async () => ({
        revision: 1,
        acceptedRevision: 1,
        revisions: [{
          fields: {
            businessName: { value: "Oceanic" },
            services: { value: ["freediving coaching"] },
          },
          createdAt: new Date("2026-11-01T00:00:00Z"),
        }],
      }),
    },
    siteProfile: {
      findUnique: async () => ({ language: overrides.language ?? "en", country: "US" }),
    },
    evidenceRecord: {
      findMany: async (args: { where: { kind: string } }) => {
        if (args.where.kind === "keyword_metrics") return metrics;
        if (args.where.kind === "keyword_rank") {
          return [{ dimensions: { query: "freediving course" }, metrics: { "first_party:impressions": { value: 12 } } }];
        }
        return [];
      },
      update: async () => ({ id: "e" }),
    },
  };
}

describe("question coverage bridge", () => {
  it("asks questions built from measured queries, not template prose", async () => {
    stored.length = 0;
    const result = await bridgeQuestionCoverageToEvidence(db() as never, {
      projectId: "project-1",
      siteId: "site-1",
      limit: 20,
    });
    expect(result.document).toBe(true);
    expect(result.keywords).toBe(2);
    const questions = stored.map((row) => (row.dimensions as { question: string }).question);
    expect(questions).toContain("How much does freediving course cost?");
    expect(questions).toContain("Is freediving course worth it?");
    // The cost word is not repeated inside the subject.
    expect(questions.some((question) => question.includes("price cost"))).toBe(false);
  });

  it("uses the site language for the question forms", async () => {
    stored.length = 0;
    await bridgeQuestionCoverageToEvidence(db({ language: "es" }) as never, {
      projectId: "project-1",
      siteId: "site-1",
      limit: 20,
    });
    const questions = stored.map((row) => (row.dimensions as { question: string }).question);
    expect(questions.some((question) => question.startsWith("¿Cuánto cuesta"))).toBe(true);
  });
});
