/**
 * Wave 0-3 smoke test against a real database.
 * Creates an ephemeral project, runs evidence -> detector -> task -> outcome,
 * verifies the invariants end to end, then deletes the project (cascade).
 */
import { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import { runDetectors } from "@/lib/funnel/detectors";
import { acceptOpportunityIntoTask, confirmHumanStep, recordDeliveryOutcome } from "@/lib/funnel/join";
import { addEdge } from "@/lib/funnel/edges";
import { withFrozenLegacyFunnel } from "@/lib/funnel/legacy-freeze";

const db = withFrozenLegacyFunnel(new PrismaClient());

async function main() {
  const marker = `smoke-${Date.now()}`;
  const workspace = await db.workspace.create({ data: { externalOrganizationId: marker, name: marker } });
  const project = await db.project.create({ data: { workspaceId: workspace.id, externalProjectId: marker, name: marker } });

  // Wave 0: raw response + evidence with provenance
  const raw = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo", product: "rank_tracking", endpoint: "serp_organic_live", providerTaskId: marker,
      locale: "en-US", requestedAt: new Date(), deliveredAt: new Date(), costMicros: 5n, status: "succeeded", payload: { ok: true },
    },
  });
  const observedAt = new Date();
  const payload = {
    projectId: project.id, kind: "keyword_rank" as const, observedAt, producer: "smoke",
    rawResponseId: raw.id,
    dimensions: { query: "smoke query", url: "https://smoke.example/a" },
    metrics: { "provider:position": { value: 6, unit: "rank", source: "provider" }, "provider:volume": { value: 500, unit: "searches/month", source: "provider" } },
  };
  const evidence = await storeEvidenceRecord(db as never, payload);
  console.log("wave0: evidence stored", evidence.id);

  // idempotency: same input (same observed timestamp) -> same record
  const again = await storeEvidenceRecord(db as never, payload);
  if (again.id !== evidence.id) throw new Error("idempotency failed");
  console.log("wave0: idempotent upsert verified");

  // legacy freeze: a write to researchRun must fail
  let froze = false;
  try {
    await db.researchRun.create({ data: { projectId: project.id, kind: "research", status: "completed" } as never });
  } catch (error) {
    froze = (error as Error).name === "LegacyFunnelWriteError";
  }
  if (!froze) throw new Error("legacy freeze did not block researchRun write");
  console.log("wave0: legacy freeze verified");

  // Wave 1: detectors find the O1 opportunity from evidence
  const run = await runDetectors(db as never, project.id, { detectedBy: "smoke" });
  if (run.created < 1) throw new Error("detector run created nothing");
  const opportunity = await db.opportunity.findFirstOrThrow({ where: { projectId: project.id, type: "O1_winnable_rank" } });
  if ((opportunity.scoreValue ?? 0) <= 0) throw new Error("opportunity not scored");
  const edges = await db.evidenceEdge.findMany({ where: { toType: "opportunity", toId: opportunity.id, relation: "supporting" } });
  if (edges.length === 0) throw new Error("opportunity has no supporting edges");
  console.log(`wave1: ${run.created} opportunities, O1 score ${opportunity.scoreValue}, ${edges.length} supporting edge(s)`);

  // Wave 2: task gate
  const taskId = await acceptOpportunityIntoTask(db as never, opportunity.id, { title: "Smoke fix", assignedTo: "smoke-human" });
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  if (task.status !== "todo") throw new Error("task did not start in todo");
  await confirmHumanStep(db as never, taskId, { status: "delivered", confirmedBy: "smoke-human" });
  console.log("wave2: task created from opportunity, human-confirmed delivery");

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
