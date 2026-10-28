import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyCap } from "@/lib/aeo/cap";
import { runEvaluation } from "@/lib/aeo/run";

const depsMocks = vi.hoisted(() => ({
  askPerplexity: vi.fn(), askGoogle: vi.fn(), saveObservation: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/aeo/perplexity", () => ({ evaluatePerplexityQuestion: depsMocks.askPerplexity }));
vi.mock("@/lib/aeo/google-ai-overview", () => ({ evaluateGoogleAiOverviewQuestion: depsMocks.askGoogle }));
vi.mock("@/lib/aeo/observation", () => ({ createObservation: depsMocks.saveObservation }));

function mockDeps(overrides: Record<string, unknown> = {}) {
  const stored: Record<string, unknown>[] = [];
  const runRows = new Map<string, Record<string, unknown>>();
  let nextId = 0;
  const aeoEvaluationRun = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const key = `${data.projectId}/${data.runId}`;
      if (runRows.has(key)) throw new Error("unique constraint");
      const row: Record<string, unknown> = { ...data, id: `run-${++nextId}`, asked: 0, stored: 0, answerAbsent: 0, failed: 0, skippedByCap: 0, costMicros: 0 };
      runRows.set(key, row); return row;
    }),
    findUnique: vi.fn(async ({ where }: { where: { projectId_runId: { projectId: string; runId: string } } }) => runRows.get(`${where.projectId_runId.projectId}/${where.projectId_runId.runId}`) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = [...runRows.values()].find((entry) => entry.id === where.id)!;
      Object.assign(row, data); return row;
    }),
  };
  const base = {
    businessKnowledgeDocument: { findUnique: vi.fn().mockResolvedValue(null) },
    siteProfile: { findUnique: vi.fn().mockResolvedValue({ topics: ["hair salons"], services: [], audience: "local customers", language: "en", country: "US" }) },
    researchRun: { findMany: vi.fn().mockResolvedValue([]) },
    site: { findUnique: vi.fn().mockResolvedValue({ domain: "example.com" }) },
    aIVisibilityObservation: { findMany: vi.fn(async ({ where }: { where: { runId: string } }) => stored.filter((observation) => observation.runId === where.runId).map((observation) => ({ id: observation.id }))) },
    aeoEvaluationRun,
  };
  const client = Object.assign(base, overrides);
  return { deps: { db: client, askPerplexity: depsMocks.askPerplexity, askGoogle: depsMocks.askGoogle, saveObservation: async (input: Record<string, unknown>) => { const row = { id: `obs-${stored.length + 1}`, ...input }; stored.push(row); return row; }, now: () => new Date("2026-10-28T12:00:00Z") } as unknown as NonNullable<Parameters<typeof runEvaluation>[1]>, stored, runRows, aeoEvaluationRun };
}
const okP = (status = "succeeded") => ({ status, promptText: "prompt", answerText: status === "answer_absent" ? null : "Answer", modelVersion: "sonar", citedUrls: [], mentionedBrands: [], costEstimate: 0.00001 });
const okG = (state = "succeeded") => ({ state, device: "desktop", answerText: state === "overview_absent" ? null : "Answer", citations: [], brandPresent: false, costMicros: 25 });

describe("AEO evaluation runs", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("enforces a hard request cap across providers and records skips", async () => {
    const harness = mockDeps(); depsMocks.askPerplexity.mockResolvedValue(okP()); depsMocks.askGoogle.mockResolvedValue(okG());
    const receipt = await runEvaluation({ projectId: "p", siteId: "s", trigger: "scheduled", providers: ["perplexity", "google"], cap: 1 }, harness.deps);
    expect(receipt).toMatchObject({ asked: 1, skippedByCap: 7, stored: 1, costMicros: 10 });
    expect(depsMocks.askPerplexity).toHaveBeenCalledTimes(1);
    expect(depsMocks.askGoogle).not.toHaveBeenCalled();
  });
  it("stores answer absence, excludes failed calls, and returns consistent receipt counts", async () => {
    const harness = mockDeps();
    depsMocks.askPerplexity.mockResolvedValue(okP("answer_absent"));
    depsMocks.askGoogle.mockResolvedValue({ ...okG(), state: "request_failed" });
    const receipt = await runEvaluation({ projectId: "p", siteId: "s", trigger: "action", actionId: "a1", actionRevision: 1, question: "Which salon?", providers: ["perplexity", "google"] }, harness.deps);
    expect(receipt).toMatchObject({ asked: 2, stored: 1, answerAbsent: 1, failed: 1, skippedByCap: 0, costMicros: 35 });
    expect(harness.stored).toHaveLength(1);
    expect(harness.stored[0]).toMatchObject({ aiAnswerPresent: false, requestStatus: "succeeded" });
    expect(receipt.observationIds).toEqual(["obs-1"]);
  });
  it("does not repeat paid calls after a failed run", async () => {
    const harness = mockDeps(); depsMocks.askPerplexity.mockResolvedValue({ ...okP(), status: "request_failed" });
    const input = { projectId: "p", siteId: "s", trigger: "scheduled" as const, providers: ["perplexity" as const], cap: 1 };
    const first = await runEvaluation(input, harness.deps);
    expect(first).toMatchObject({ asked: 1, failed: 1, stored: 0 });
    const replay = await runEvaluation(input, harness.deps);
    expect(replay).toMatchObject({ runId: first.runId, asked: 1, failed: 1, stored: 0 });
    expect(depsMocks.askPerplexity).toHaveBeenCalledTimes(1);
  });
  it("replays once per action revision and asks again for a higher revision", async () => {
    const harness = mockDeps(); depsMocks.askPerplexity.mockResolvedValue(okP());
    const input = { projectId: "p", siteId: "s", trigger: "action" as const, actionId: "a1", actionRevision: 4, question: "Which salon?", providers: ["perplexity" as const] };
    const first = await runEvaluation(input, harness.deps);
    const replay = await runEvaluation(input, harness.deps);
    expect(replay).toMatchObject({ runId: "action:a1:r4", asked: 1, stored: 1, observationIds: first.observationIds });
    expect(depsMocks.askPerplexity).toHaveBeenCalledTimes(1);
    const nextRevision = await runEvaluation({ ...input, actionRevision: 5 }, harness.deps);
    expect(nextRevision.runId).toBe("action:a1:r5");
    expect(depsMocks.askPerplexity).toHaveBeenCalledTimes(2);
    expect(harness.stored.map((observation) => observation.runId)).toEqual(["action:a1:r4", "action:a1:r5"]);
  });
  it("applies the pure paid-request cap", () => {
    expect(applyCap(4, 5, 3)).toEqual({ allowed: 2, skipped: 2 });
    expect(applyCap(1, 5, 5)).toEqual({ allowed: 0, skipped: 1 });
  });
});
