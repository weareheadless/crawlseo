import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  enqueue: vi.fn(),
  pipeline: vi.fn(),
}));

vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: store.enqueue }));
vi.mock("@/lib/research/pipeline", () => ({ runResearchPipeline: store.pipeline }));

import { runMonthlyCycle } from "@/lib/jobs/monthly-cycle";
import { runPipelineJob } from "@/lib/jobs/research-pipeline-job";
import type { PipelineResult, PipelineStageResult } from "@/lib/research/pipeline";

/**
 * The monthly cycle used to stop after the research run. Its tail — the paid
 * bundle, the topic map, the proposals — only ran when a person typed three
 * scripts in the right order, which is how a map came to be built before the
 * bundle it was supposed to read.
 *
 * These tests are that the tail is now queued, once per month, and that a job
 * which cannot spend says so instead of spending or silently doing nothing.
 */

function stage(
  name: PipelineStageResult["stage"],
  status: PipelineStageResult["status"],
  detail = ""
): PipelineStageResult {
  return { stage: name, status, runId: null, detail };
}

function pipelineResult(stages: PipelineStageResult[], blockedBy: PipelineResult["blockedBy"] = null): PipelineResult {
  return { siteId: "s1", month: "2026-11", mode: "execute", stages, blockedBy };
}

function cycleDb(overrides: { opportunityRun?: { id: string; status: string } | null; existingJob?: unknown } = {}) {
  return {
    site: {
      findMany: async () => [
        {
          id: "s1",
          domain: "example.test",
          projectId: "p1",
          userId: "u1",
          siteProfile: { topics: ["Fitted wardrobes"], audience: null },
          researchPolicy: { enabled: false },
        },
      ],
    },
    job: {
      findUnique: async () => overrides.existingJob ?? null,
    },
    crawl: { create: async () => ({ id: "crawl-1" }) },
    researchRun: {
      findFirst: async ({ where }: { where: { idempotencyKey?: string } }) =>
        where.idempotencyKey?.startsWith("opportunities:") ? (overrides.opportunityRun ?? null) : null,
    },
    siteProfile: { findUnique: async () => ({ topics: [], audience: null }) },
    task: { findMany: async () => [] },
    outcomeObservation: { findMany: async () => [], findFirst: async () => null, create: async () => ({}) },
    evidenceRecord: { findMany: async () => [] },
  } as never;
}

beforeEach(() => {
  store.enqueue.mockReset();
  store.pipeline.mockReset();
  store.enqueue.mockResolvedValue({ id: "job-1", status: "PENDING" });
});

describe("the monthly cycle queues the research pipeline", () => {
  it("queues it once per month, keyed so it cannot double-queue", async () => {
    const results = await runMonthlyCycle(cycleDb(), { now: new Date("2026-11-04T00:00:00.000Z") });
    const pipelineStage = results[0].stages.find((entry) => entry.stage === "pipeline");

    expect(pipelineStage?.status).toBe("queued");
    const queued = store.enqueue.mock.calls.find((call) => call[0].payload?.pipeline === "monthly");
    expect(queued?.[0]).toMatchObject({
      siteId: "s1",
      idempotencyKey: "monthly:2026-11:research-pipeline",
      payload: { pipeline: "monthly", month: "2026-11" },
    });
  });

  it("carries no approval reference, so the paid bundle reports blocked rather than spending", async () => {
    await runMonthlyCycle(cycleDb(), { now: new Date("2026-11-04T00:00:00.000Z") });
    const queued = store.enqueue.mock.calls.find((call) => call[0].payload?.pipeline === "monthly");
    expect(queued?.[0].payload).not.toHaveProperty("approval");
    // The stage says why, rather than the requirement being invisible.
    expect((await runMonthlyCycle(cycleDb(), { dryRun: true, now: new Date("2026-11-04T00:00:00.000Z") }))[0].stages
      .find((entry) => entry.stage === "pipeline")?.detail).toContain("approval");
  });

  it("skips the pipeline when proposals already completed this month", async () => {
    const results = await runMonthlyCycle(cycleDb({ opportunityRun: { id: "opp-1", status: "COMPLETED" } }), {
      now: new Date("2026-11-04T00:00:00.000Z"),
    });
    const pipelineStage = results[0].stages.find((entry) => entry.stage === "pipeline");
    expect(pipelineStage?.status).toBe("skipped");
    expect(pipelineStage?.detail).toContain("opp-1");
    expect(store.enqueue.mock.calls.some((call) => call[0].payload?.pipeline === "monthly")).toBe(false);
  });

  it("skips when the job for this month already exists", async () => {
    const results = await runMonthlyCycle(cycleDb({ existingJob: { id: "job-9", status: "PENDING" } }), {
      now: new Date("2026-11-04T00:00:00.000Z"),
    });
    expect(results[0].stages.find((entry) => entry.stage === "pipeline")?.status).toBe("skipped");
    expect(store.enqueue).not.toHaveBeenCalled();
  });
});

describe("the pipeline job", () => {
  it("treats a blocked stage as terminal: no retry can supply an approval reference", async () => {
    store.pipeline.mockResolvedValue(
      pipelineResult(
        [
          stage("bundle", "blocked", "execute requires an approval reference"),
          stage("topic-map", "blocked"),
          stage("opportunities", "blocked"),
        ],
        "bundle"
      )
    );
    const outcome = await runPipelineJob(cycleDb(), { siteId: "s1", month: "2026-11" });
    expect(outcome.status).toBe("blocked");
    expect(outcome.terminal).toBe(true);
    expect(outcome.detail).toContain("bundle=blocked");
  });

  it("treats a failed stage as a job failure, so the worker retries it", async () => {
    store.pipeline.mockResolvedValue(
      pipelineResult([stage("bundle", "failed", "no credentials"), stage("topic-map", "blocked"), stage("opportunities", "blocked")], "bundle")
    );
    const outcome = await runPipelineJob(cycleDb(), { siteId: "s1", month: "2026-11" });
    expect(outcome.status).toBe("failed");
    expect(outcome.terminal).toBe(false);
    expect(outcome.detail).toContain("no credentials");
  });

  it("reports completed when all three stages satisfy the gate", async () => {
    store.pipeline.mockResolvedValue(
      pipelineResult([stage("bundle", "completed"), stage("topic-map", "completed"), stage("opportunities", "skipped")])
    );
    const outcome = await runPipelineJob(cycleDb(), { siteId: "s1", month: "2026-11" });
    expect(outcome.status).toBe("completed");
    expect(outcome.detail).toBe("bundle=completed topic-map=completed opportunities=skipped");
  });
});
