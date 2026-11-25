import type { PrismaClient } from "@prisma/client";

import { runResearchPipeline, type PipelineResult } from "@/lib/research/pipeline";

/**
 * The queued form of the research pipeline.
 *
 * The pipeline is three staged calls, and a worker invocation is the natural
 * place for them: the monthly cycle queues one job per site, the worker runs it
 * and records what each stage did. Before this, the tail of the pipeline only
 * ran when a person typed three scripts in the right order, which is how a
 * topic map ended up built before its bundle on three sites.
 *
 * What this adds on top of `runResearchPipeline` is only the two things a queue
 * needs: a job-shaped result to log, and the rule that a *blocked paid stage* is
 * not a job failure. Nothing was bought and nothing was attempted, so retrying
 * the job would not help — it needs an approval reference, which is a decision,
 * not a transient fault. A stage that genuinely failed is a job failure.
 */

export type PipelineJobPayload = {
  /** Present when the job is the pipeline rather than a research run. */
  pipeline: "monthly";
  /** YYYY-MM; the cycle passes the month it is running. */
  month?: string;
};

export type PipelineJobDb = PrismaClient;

export type PipelineJobResult = {
  status: "completed" | "partial" | "blocked" | "failed";
  /** True when retrying this job cannot change the outcome. */
  terminal: boolean;
  result: PipelineResult;
  detail: string;
};

export async function runPipelineJob(
  db: PipelineJobDb,
  input: {
    siteId: string;
    month?: string;
    approval?: string | null;
    refresh?: boolean;
  }
): Promise<PipelineJobResult> {
  const result = await runResearchPipeline(db, {
    siteId: input.siteId,
    month: input.month,
    mode: "execute",
    approval: input.approval,
    refresh: input.refresh,
    onNote: (message) => console.log(`[CrawlSEO worker] pipeline: ${message}`),
  });

  const statuses = result.stages.map((stage) => stage.status);
  const summarise = () => result.stages.map((stage) => `${stage.stage}=${stage.status}`).join(" ");

  if (statuses.includes("failed")) {
    const failed = result.stages.find((stage) => stage.status === "failed");
    return {
      status: "failed",
      terminal: false,
      result,
      detail: `${summarise()}${failed ? `; ${failed.stage}: ${failed.detail}` : ""}`,
    };
  }
  if (statuses.includes("blocked")) {
    return {
      status: "blocked",
      // Blocked means a precondition nobody can satisfy by retrying: usually the
      // paid bundle has no approval reference. Retrying is a no-op that burns a
      // worker attempt, so this is reported and left alone.
      terminal: true,
      result,
      detail: `${summarise()}${result.blockedBy ? `; stopped at ${result.blockedBy}` : ""}`,
    };
  }
  if (statuses.includes("partial")) {
    return { status: "partial", terminal: true, result, detail: summarise() };
  }
  return { status: "completed", terminal: true, result, detail: summarise() };
}
