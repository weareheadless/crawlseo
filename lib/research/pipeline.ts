import type { PrismaClient } from "@prisma/client";

import { bundleKey, findBundleRun, runMonthlyBundle, type BundleResult } from "@/lib/research/monthly-bundle";
import { runTopicMapStage } from "@/lib/research/topic-map-stage";
import { readTopicMapStaleness } from "@/lib/research/map-staleness";
import { runOpportunitiesStage } from "@/lib/research/opportunities-stage";

/**
 * One research pipeline, in the order the data requires.
 *
 * The defect this replaces: the three stages that produce a board —
 * `monthly-bundle` (paid evidence), `topic-map` (clusters) and
 * `research-opportunities` (proposals) — were three scripts and nothing
 * sequenced them. Measured on 2026-11-25, the map ran two hours before the
 * bundle on astridrincon and 37 minutes before it on casamigo, so both sites
 * got clusters built from data that did not exist yet: five service clusters
 * with zero queries, which is indistinguishable on the board from "this site
 * has no demand".
 *
 * This module is the only thing that sequences those three. Each stage keeps
 * its own existing idempotency key; the pipeline adds order and a gate, not a
 * fourth record of "already done".
 *
 * The gate is deliberately strict:
 *
 *  - A stage runs only when its predecessor produced a `COMPLETED` run.
 *  - `PARTIAL` blocks. A partial bundle on a site with volume is exactly how a
 *    map ends up empty, so continuing quietly is the defect, not the fix. A
 *    caller that has read the receipt can pass `allowPartial`.
 *  - `FAILED` stops the pipeline. It never drafts proposals from half evidence.
 *  - A gated stage is reported as `blocked` with the reason, never omitted.
 */

export type PipelineDb = PrismaClient;

export type PipelineStageName = "bundle" | "topic-map" | "opportunities";

export type PipelineStageStatus =
  | "completed"
  /** This call did nothing because a completed run already existed. Gating treats it as satisfied. */
  | "skipped"
  /** Ran, and its own receipt says the result is incomplete. Blocks downstream by default. */
  | "partial"
  | "failed"
  /** Did not run because a predecessor did not satisfy the gate. */
  | "blocked";

export type PipelineStageResult = {
  stage: PipelineStageName;
  status: PipelineStageStatus;
  runId: string | null;
  detail: string;
};

export type PipelineResult = {
  siteId: string;
  month: string;
  mode: "dry-run" | "execute";
  stages: PipelineStageResult[];
  /** The stage that stopped the pipeline, when one did. Null when all three ran. */
  blockedBy: PipelineStageName | null;
};

/**
 * The three stage runners, injectable so the gate can be tested without a
 * model call or a provider call. Production code never passes this; the
 * defaults below are the real stages, so there is still exactly one
 * implementation of each.
 */
export type PipelineDeps = {
  bundle: typeof runMonthlyBundle;
  topicMap: typeof runTopicMapStage;
  opportunities: typeof runOpportunitiesStage;
};

const defaultDeps: PipelineDeps = {
  bundle: runMonthlyBundle,
  topicMap: runTopicMapStage,
  opportunities: runOpportunitiesStage,
};

export type PipelineInput = {
  siteId: string;
  month?: string;
  mode: "dry-run" | "execute";
  /**
   * The owner reference the paid bundle requires. Without it on `execute`, the
   * bundle is reported `blocked` and nothing paid is attempted.
   */
  approval?: string | null;
  /** Re-run stages that already have a completed run. */
  refresh?: boolean;
  /** Continue past a `PARTIAL` bundle. Explicit, never implicit. */
  allowPartial?: boolean;
  /** Provider caps for the bundle, when a caller wants to bound it. */
  caps?: Parameters<typeof runMonthlyBundle>[1]["caps"];
  /** Progress lines, for a CLI. */
  onNote?: (message: string) => void;
  /** Tests only: replace a stage runner. Never set in production code. */
  deps?: Partial<PipelineDeps>;
};

/** A status that satisfies the gate for the stage after it. */
function satisfiesGate(status: PipelineStageStatus): boolean {
  return status === "completed" || status === "skipped";
}

function normalizeMonth(month: string | undefined, now: Date): string {
  if (!month || !month.trim()) return now.toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month.trim())) {
    throw new Error(`month must be YYYY-MM, got "${month}"`);
  }
  return month.trim();
}

/**
 * Map a bundle receipt onto a pipeline status.
 *
 * `existing` is a completed run being reused, which satisfies the gate; it is
 * not the same thing as "this call did the work", and the detail says so.
 */
function bundleStatus(result: BundleResult): { status: PipelineStageStatus; detail: string } {
  switch (result.status) {
    case "completed":
      return { status: "completed", detail: `bundle stored, ${result.paidCalls} paid calls, $${(result.totalCostMicros / 1_000_000).toFixed(4)}` };
    case "existing":
      return { status: "skipped", detail: `completed bundle ${result.runId} reused; nothing paid` };
    case "planned":
      return { status: "completed", detail: `dry run: ${result.plan.selected ? "plan built" : "plan built"}, nothing paid` };
    case "partial":
      return { status: "partial", detail: `bundle incomplete: ${result.error ?? "a section failed, was partial, or the cap was reached"}` };
    case "refused":
      return { status: "blocked", detail: result.error ?? "bundle refused" };
    case "failed":
    default:
      return { status: "failed", detail: `bundle failed: ${result.error ?? "unknown error"}` };
  }
}

export async function runResearchPipeline(
  db: PipelineDb,
  input: PipelineInput
): Promise<PipelineResult> {
  const note = input.onNote ?? (() => {});
  const deps: PipelineDeps = { ...defaultDeps, ...input.deps };
  const month = normalizeMonth(input.month, new Date());
  const stages: PipelineStageResult[] = [];

  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { id: true, domain: true, projectId: true, retiredAt: true },
  });
  if (!site) throw new Error(`site ${input.siteId} not found`);
  if (site.retiredAt) throw new Error(`site ${site.domain} is retired`);
  if (!site.projectId) throw new Error(`site ${site.domain} is not attached to a project`);

  /**
   * Always report all three stages. A pipeline that returns two rows because it
   * stopped reads as a shorter pipeline, and the whole point of this module is
   * that a stop is visible: the stage that did not run is present with the
   * reason, at the position it would have occupied.
   */
  const order: PipelineStageName[] = ["bundle", "topic-map", "opportunities"];
  const finish = (blockedBy: PipelineStageName | null): PipelineResult => {
    for (const stage of order) {
      if (stages.some((entry) => entry.stage === stage)) continue;
      stages.push({
        stage,
        status: "blocked",
        runId: null,
        detail: blockedBy
          ? `not run: ${blockedBy} did not produce a usable result`
          : "not run: a previous stage did not produce a usable result",
      });
    }
    stages.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
    return { siteId: site.id, month, mode: input.mode, stages, blockedBy };
  };

  // ---- 1. bundle -----------------------------------------------------------
  //
  // A stage whose own preconditions are missing is a finding about the site, not
  // a crash: inmersionfreediving has no market or country in any of business
  // knowledge, the site profile or its domain, so the bundle cannot even plan.
  // That must read as `failed` with the reason, so a reader sees the site needs
  // its market filled in rather than the pipeline appearing to be broken.
  const existingBundle = await findBundleRun(db, site.id, bundleKey(site.id, month));
  if (input.mode === "dry-run") {
    try {
      const plan = await deps.bundle(db, {
        siteId: site.id,
        month,
        mode: "dry-run",
        caps: input.caps,
      });
      const mapped = bundleStatus(plan);
      stages.push({ stage: "bundle", status: mapped.status, runId: plan.runId, detail: mapped.detail });
    } catch (error) {
      stages.push({
        stage: "bundle",
        status: "failed",
        runId: null,
        detail: `bundle cannot be planned: ${error instanceof Error ? error.message : String(error)}`,
      });
      return finish("bundle");
    }
  } else if (existingBundle?.status === "COMPLETED" && !input.refresh) {
    // The receipt is the gate. Reusing it is what stops paying twice for one
    // month, which is the whole reason the bundle records a key.
    stages.push({
      stage: "bundle",
      status: "skipped",
      runId: existingBundle.id,
      detail: `completed bundle ${existingBundle.id} reused; nothing paid (pass refresh to re-buy)`,
    });
  } else {
    const approval = input.approval?.trim();
    if (!approval) {
      // No approval means no paid call. Reported, not silently skipped: a
      // pipeline that appears to have run is worse than one that says why not.
      stages.push({
        stage: "bundle",
        status: "blocked",
        runId: null,
        detail: "execute requires an approval reference for the paid bundle; nothing was bought and no later stage ran",
      });
      return finish("bundle");
    }
    try {
      const bundle = await deps.bundle(db, {
        siteId: site.id,
        month,
        mode: "execute",
        approval,
        resume: Boolean(input.refresh && existingBundle),
        caps: input.caps,
      });
      const mapped = bundleStatus(bundle);
      stages.push({ stage: "bundle", status: mapped.status, runId: bundle.runId, detail: mapped.detail });
    } catch (error) {
      // A refused or failed bundle is the gate's job to report, not to throw
      // past: the pipeline stops at this stage either way, and the caller needs
      // the reason in the same shape as every other stage.
      stages.push({
        stage: "bundle",
        status: "failed",
        runId: null,
        detail: `bundle did not run: ${error instanceof Error ? error.message : String(error)}`,
      });
      return finish("bundle");
    }
  }

  const bundleStage = stages[0];
  if (bundleStage.status === "partial" && !input.allowPartial) {
    note(`bundle is partial, so the topic map does not run; pass allowPartial to continue`);
    return finish("bundle");
  }
  if (!satisfiesGate(bundleStage.status) && bundleStage.status !== "partial") {
    return finish("bundle");
  }

  // ---- 2. topic map --------------------------------------------------------
  if (input.mode === "dry-run") {
    // Selecting queries is free; building the map is not (the job map is one
    // model call when none is stored). A dry run reports the stage and does not
    // start it, so the plan never spends.
    const mapRun = await db.researchRun.findFirst({
      where: { siteId: site.id, idempotencyKey: `topic-map:${site.id}:${month}` },
      select: { id: true, status: true },
    });
    stages.push({
      stage: "topic-map",
      status: mapRun?.status === "COMPLETED" && !input.refresh ? "skipped" : "blocked",
      runId: mapRun?.id ?? null,
      detail:
        mapRun?.status === "COMPLETED" && !input.refresh
          ? `completed map ${mapRun.id} would be reused`
          : "dry run: the topic map would run after the bundle completes; it is not started here because it costs a model call",
    });
  } else {
    const topicStage = await deps.topicMap(db, {
      siteId: site.id,
      month,
      mode: "execute",
      approval: input.approval,
      refresh: input.refresh,
      onNote: note,
    });
    stages.push({
      stage: "topic-map",
      status:
        topicStage.status === "completed" ? "completed" : topicStage.status === "skipped" ? "skipped" : "failed",
      runId: topicStage.runId,
      detail: topicStage.detail,
    });
  }

  const mapStage = stages[1];
  if (!satisfiesGate(mapStage.status)) {
    note(`topic map did not complete, so no proposals are drafted`);
    return finish("topic-map");
  }

  // A reused map that predates its bundle still satisfies the gate — its
  // clusters are real, just older than the evidence — but the staleness follows
  // the result, so drafting over an out-of-date map is stated rather than left
  // buried in a detail string a reader has to parse.
  let mapIsStale = false;
  if (input.mode === "execute" && mapStage.status === "skipped") {
    const staleness = await readTopicMapStaleness(db, { siteId: site.id, month });
    if (staleness && staleness.state !== "current") {
      mapIsStale = true;
      note(`topic map is ${staleness.state}: ${staleness.detail}`);
    }
  }

  // ---- 3. opportunities ----------------------------------------------------
  if (input.mode === "dry-run") {
    const opportunityRun = await db.researchRun.findFirst({
      where: { siteId: site.id, idempotencyKey: `opportunities:${site.id}:${month}` },
      select: { id: true, status: true },
    });
    stages.push({
      stage: "opportunities",
      status: opportunityRun?.status === "COMPLETED" && !input.refresh ? "skipped" : "blocked",
      runId: opportunityRun?.id ?? null,
      detail:
        opportunityRun?.status === "COMPLETED" && !input.refresh
          ? `completed proposals ${opportunityRun.id} would be reused`
          : "dry run: proposals would be drafted after the topic map completes; not started here because it costs a model call",
    });
    return finish(null);
  }

  const opportunityStage = await deps.opportunities(db, {
    siteId: site.id,
    month,
    mode: "execute",
    approval: input.approval,
    refresh: input.refresh,
    onNote: note,
  });
  stages.push({
    stage: "opportunities",
    status:
      opportunityStage.status === "completed"
        ? "completed"
        : opportunityStage.status === "skipped"
          ? "skipped"
          : "failed",
    runId: opportunityStage.runId,
    detail: mapIsStale
      ? `${opportunityStage.detail}; drafted from a topic map that is older than its bundle`
      : opportunityStage.detail,
  });

  return finish(satisfiesGate(stages[2].status) ? null : "opportunities");
}
