/**
 * Wave 0-3 smoke test against a real database.
 * Creates an ephemeral project, runs evidence -> detector -> task -> outcome,
 * verifies the invariants end to end, then deletes the project (cascade).
 */
import { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import { runDetectors } from "@/lib/funnel/detectors";
import { upsertCluster, recomputeDemandMap } from "@/lib/funnel/demand-map";
import { acceptOpportunityIntoTask, applyJoin, computeFollowUps, confirmHumanStep, recordAgentPreparation, recordDeliveryOutcome } from "@/lib/funnel/join";
import { addEdge } from "@/lib/funnel/edges";
import { withFrozenLegacyFunnel } from "@/lib/funnel/legacy-freeze";

const db = withFrozenLegacyFunnel(new PrismaClient());

async function main() {
  const marker = `smoke-${Date.now()}`;
  const workspace = await db.workspace.create({ data: { externalOrganizationId: marker, name: marker } });
  const project = await db.project.create({ data: { workspaceId: workspace.id, externalProjectId: marker, name: marker } });
  const site = await db.site.create({ data: { projectId: project.id, domain: `${marker}.example` }, select: { id: true } });
  const siteId = site.id;

  // Wave 0: raw response + evidence with provenance
  const raw = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo", product: "rank_tracking", endpoint: "serp_organic_live", providerTaskId: marker,
      locale: "en-US", requestedAt: new Date(), deliveredAt: new Date(), costMicros: BigInt(5), status: "succeeded", payload: { ok: true },
    },
  });
  const observedAt = new Date();
  const payload = {
    projectId: project.id, kind: "keyword_rank" as const, observedAt, producer: "smoke",
    rawResponseId: raw.id,
    dimensions: { query: "smoke query", url: "https://smoke.example/a" },
    metrics: {
      "provider:position": { value: 6, unit: "rank", source: "provider" as const },
      "provider:volume": { value: 500, unit: "searches/month", source: "provider" as const },
    },
  };
  const evidence = await storeEvidenceRecord(db as never, payload);
  console.log("wave0: evidence stored", evidence.id);

  // idempotency: same input (same observed timestamp) -> same record
  const again = await storeEvidenceRecord(db as never, payload);
  if (again.id !== evidence.id) throw new Error("idempotency failed");
  console.log("wave0: idempotent upsert verified");

  // legacy freeze: a write to researchRun must fail, reads must pass through
  // Wave 6 step 2: the strict freeze covers only tables proven to have no
  // scheduled writer, so the smoke checks one of those.
  process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE = "strict";
  const frozenDb = withFrozenLegacyFunnel(new PrismaClient());
  let froze = false;
  try {
    await frozenDb.rankSnapshot.create({ data: { siteId, query: "smoke", date: new Date(), position: 1 } as never });
  } catch (error) {
    froze = (error as Error).name === "LegacyFunnelWriteError";
  }
  if (!froze) throw new Error("legacy freeze did not block rankSnapshot write");
  const legacyRead = await frozenDb.rankSnapshot.findMany({ where: { siteId } });
  if (!Array.isArray(legacyRead)) throw new Error("legacy read pass-through failed");
  console.log("wave0: legacy freeze verified (write blocked, read open)");

  // Wave 1: detectors find the O1 opportunity from evidence
  const run = await runDetectors(db as never, project.id, { detectedBy: "smoke" });
  if (run.created < 1) throw new Error("detector run created nothing");
  const opportunity = await db.opportunity.findFirstOrThrow({ where: { projectId: project.id, type: "O1_winnable_rank" } });
  if ((opportunity.scoreValue ?? 0) <= 0) throw new Error("opportunity not scored");
  const edges = await db.evidenceEdge.findMany({ where: { toType: "opportunity", toId: opportunity.id, relation: "supporting" } });
  if (edges.length === 0) throw new Error("opportunity has no supporting edges");
  console.log(`wave1: ${run.created} opportunities, O1 score ${opportunity.scoreValue}, ${edges.length} supporting edge(s)`);

  // Wave 1 (one-legged + join): a research finding becomes an O13 with only the why leg
  const finding = await storeEvidenceRecord(db as never, {
    projectId: project.id, kind: "research_finding", observedAt, producer: "smoke-research",
    dimensions: { painPoint: "true", painPointSummary: "smoke pain point" },
    metrics: {},
  });
  const afterFindings = await runDetectors(db as never, project.id, { detectedBy: "smoke" });
  const o13 = await db.opportunity.findFirstOrThrow({ where: { projectId: project.id, type: "O13_user_pain_point" } });
  if (o13.evidenceCompleteness !== "why") throw new Error(`O13 leg expected "why", got ${o13.evidenceCompleteness}`);
  const followUps = await computeFollowUps(db as never, project.id);
  if (!followUps.some((request) => request.opportunityId === o13.id && request.missingLeg === "how")) {
    throw new Error("join scheduler did not schedule keyword validation for O13");
  }
  const keywordRaw = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo", product: "keywords_data", endpoint: "search_volume_live", providerTaskId: `${marker}-kw`,
      locale: "en-US", requestedAt: observedAt, deliveredAt: observedAt, costMicros: BigInt(2), status: "succeeded", payload: { ok: true },
    },
  });
  const rankEvidence = await storeEvidenceRecord(db as never, {
    projectId: project.id, kind: "keyword_metrics", observedAt, producer: "smoke-keywords",
    rawResponseId: keywordRaw.id,
    dimensions: { query: "smoke pain point" },
    metrics: { "provider:volume": { value: 800, unit: "searches/month", source: "provider" } },
  });
  const joined = await applyJoin(
    db as never, o13.id,
    { id: rankEvidence.id, observedAt, metrics: {}, dimensions: {} },
    "how",
    { worth: { volume: 800, ctrAtPosition: 0.04, businessValue: 0.9 }, winProbability: { rankDistance: 0.5, authorityGap: 0.5, pageStrength: 0.5, serpCompetition: 0.5, playTypeFactor: 0.5 }, effort: { playTypeBase: 16, sizeFactor: 1 }, freshness: 1, stability: 0.8 },
    { joinedBy: "smoke" }
  );
  if (joined.evidenceCompleteness !== "both") throw new Error("join did not complete the both legs");
  if ((joined.scoreValue ?? 0) <= (o13.scoreValue ?? 0)) throw new Error("join did not upgrade the score");
  console.log(`wave1: O13 detected one-legged (why), join upgraded to both legs, score ${o13.scoreValue} -> ${joined.scoreValue}`);
  void afterFindings;

  // Demand map: curated cluster + recomputable rollup over evidence
  await upsertCluster(db as never, {
    projectId: project.id, slug: "smoke", name: "Smoke cluster", topicSummary: "smoke need",
    intent: "commercial", businessRelevance: { relevance: "core", decidedBy: "smoke-human" }, tracked: true,
  });
  const rollups = await recomputeDemandMap(db as never, project.id);
  const smokeCluster = rollups.find((entry) => entry.slug === "smoke");
  if (!smokeCluster) throw new Error("demand map rollup missing the curated cluster");
  console.log(`wave1: demand map rollup — tracked ${smokeCluster.trackedQueries}, coverage ${smokeCluster.coverageRatio}`);

  // Wave 2: task gate, agent preparation, human confirmation
  const taskId = await acceptOpportunityIntoTask(db as never, opportunity.id, { title: "Smoke fix", assignedTo: "smoke-human" });
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  if (task.status !== "todo") throw new Error("task did not start in todo");
  await recordAgentPreparation(db as never, taskId, { agentId: "smoke-agent", plan: { steps: ["draft update"] } });
  const awaiting = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  if (awaiting.status !== "awaiting_human") throw new Error("agent preparation did not land in awaiting_human");
  if (awaiting.humanConfirmedBy != null) throw new Error("agent artifact must not carry a human confirmation");
  await confirmHumanStep(db as never, taskId, { status: "delivered", confirmedBy: "smoke-human" });
  console.log("wave2: task created from opportunity, agent-prepared to awaiting_human, human-confirmed delivery");

  // Wave 3: baseline + outcome
  const baseline = await db.baseline.create({ data: { taskId, metrics: { "provider:position": { value: 6, unit: "rank" } }, observedAt: new Date(Date.now() - 86400000) } });
  await recordDeliveryOutcome(db as never, {
    taskId,
    baseline: { metrics: { "provider:position": { value: 6, unit: "rank" } }, observedAt: baseline.observedAt },
    after: { metrics: { "provider:position": { value: 3, unit: "rank" } }, observedAt: new Date() },
    verdict: "verified_win",
    measuredBy: "smoke",
  });
  const outcome = await db.outcomeObservation.findFirstOrThrow({ where: { taskId }, orderBy: { createdAt: "desc" } });
  const deliveredTask = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  if (deliveredTask.status !== "verified_outcome") throw new Error("task did not reach verified_outcome");
  console.log("wave3: outcome recorded, verdict verified_win, task verified_outcome");

  // Edge write for lineage completeness
  await addEdge(db as never, { fromType: "task", fromId: taskId, toType: "opportunity", toId: opportunity.id, relation: "produced_by", createdBy: "smoke" });
  console.log("lineage: task->opportunity edge stored");

  // cleanup
  await db.project.delete({ where: { id: project.id } });
  await db.workspace.delete({ where: { id: workspace.id } });
  console.log("cleanup: ephemeral project removed");
  console.log("SMOKE OK");
}

main()
  .catch((error) => { console.error("SMOKE FAILED:", error); process.exitCode = 1; })
  .finally(() => db.$disconnect());
