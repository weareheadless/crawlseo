/**
 * One-off repair: remove why-leg edges that the matcher should never have made.
 *
 * The first matcher tokenised the whole title, URLs included, so every page whose
 * URL contains the brand name matched the business name. This drops those edges,
 * recomputes completeness from the remaining edges, and re-scores with the stored
 * inputs.
 *
 *   npx tsx scripts/repair-knowledge-joins.ts --project <projectId> [--apply]
 */
import { PrismaClient } from "@prisma/client";
import { matchKnowledgeFact } from "@/lib/funnel/join-runner";
import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

const apply = process.argv.includes("--apply");
const projectArg = process.argv.indexOf("--project");
const projectId = projectArg >= 0 ? process.argv[projectArg + 1] : "";
if (!projectId) throw new Error("--project <projectId> is required");

const db = new PrismaClient();

async function main() {
  const facts = await db.evidenceRecord.findMany({
    where: { projectId, kind: "knowledge_fact", supersededById: null },
    select: { id: true, kind: true, observedAt: true, dimensions: true, metrics: true },
  });
  const factIds = new Set(facts.map((fact) => fact.id));
  const opportunities = await db.opportunity.findMany({
    where: { projectId, status: { in: ["detected", "accepted", "in_progress"] } },
    select: { id: true, title: true, summary: true, scoreInputs: true, evidenceCompleteness: true, clusterId: true },
  });
  const clusters = await db.demandMapCluster.findMany({ where: { projectId }, select: { id: true, slug: true } });
  const slug = new Map(clusters.map((cluster) => [cluster.id, cluster.slug]));

  let removed = 0;
  let rescored = 0;
  for (const opportunity of opportunities) {
    const edges = await db.evidenceEdge.findMany({
      where: { toType: "opportunity", toId: opportunity.id, relation: "supporting" },
      select: { id: true, fromId: true },
    });
    const whyEdges = edges.filter((edge) => factIds.has(edge.fromId));
    if (whyEdges.length === 0) continue;

    const match = matchKnowledgeFact(
      { title: opportunity.title, summary: opportunity.summary, clusterSlug: opportunity.clusterId ? slug.get(opportunity.clusterId) ?? null : null },
      facts
    );
    const keep = match?.fact.id ?? null;
    const stale = whyEdges.filter((edge) => edge.fromId !== keep);
    const remainingWhy = whyEdges.length - stale.length;
    const remainingHow = edges.length - whyEdges.length;
    const completeness = remainingWhy > 0 && remainingHow > 0 ? "both" : remainingWhy > 0 ? "why" : remainingHow > 0 ? "how" : "none";

    if (stale.length > 0 && apply) {
      await db.evidenceEdge.deleteMany({ where: { id: { in: stale.map((edge) => edge.id) } } });
    }
    removed += stale.length;

    if (completeness !== opportunity.evidenceCompleteness) {
      const stored = (opportunity.scoreInputs ?? {}) as ScoreInputs;
      const { evidenceCompleteness: _ignored, ...inputs } = stored;
      if (inputs.worth && inputs.winProbability && inputs.effort) {
        const { scoreValue } = computeScore({ ...inputs, evidenceCompleteness: completeness as ScoreInputs["evidenceCompleteness"] });
        if (apply) {
          await db.opportunity.update({
            where: { id: opportunity.id },
            data: { evidenceCompleteness: completeness as never, scoreValue, lastScoredAt: new Date() },
          });
        }
        rescored += 1;
      }
    }
  }
  console.log(JSON.stringify({ apply, opportunities: opportunities.length, removedEdges: removed, rescored }));
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(String(error).slice(0, 300));
  await db.$disconnect();
  process.exit(1);
});
