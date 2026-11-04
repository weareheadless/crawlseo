/**
 * Recompute an opportunity's evidence leg from its edge graph.
 *
 * `evidenceCompleteness` used to be recomputed on every refresh from the
 * detector's own input, and detectors pass no how evidence — the join runner
 * attaches that later. So a research refresh demoted every joined opportunity
 * back to why-only while its join edges stayed in the graph: the board said "no
 * how leg" for 23 opportunities that had one.
 *
 * The upsert now holds the leg it did not produce. This script repairs rows that
 * were already demoted, using the edges that were never lost.
 *
 *   npx tsx scripts/funnel-recompute-legs.ts --project <id> [--apply]
 */
import { PrismaClient } from "@prisma/client";

/**
 * What a join attaches, and on which leg. The join runner fills whichever leg the
 * detector left empty: a business fact becomes the why of a how-only opportunity,
 * a keyword metric becomes the how of a why-only one.
 */
const JOIN_CREATORS = ["join-runner", "funnel-join"];
const HOW_KINDS = ["keyword_metrics", "serp_snapshot"];
const WHY_KINDS = ["knowledge_fact", "research_finding", "question_coverage"];

function value(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
  const projectId = value("--project");
  const apply = process.argv.includes("--apply");
  if (!projectId) throw new Error("--project <id> is required");

  const db = new PrismaClient();
  const rows = await db.$queryRawUnsafe<Array<{ id: string; evidenceCompleteness: string; joinHow: number; joinWhy: number }>>(
    `SELECT o."id",
            o."evidenceCompleteness",
            COUNT(DISTINCT CASE WHEN e."createdBy"::text = ANY($2::text[]) AND r."kind"::text = ANY($3::text[]) THEN e."fromId" END)::int AS "joinHow",
            COUNT(DISTINCT CASE WHEN e."createdBy"::text = ANY($2::text[]) AND r."kind"::text = ANY($4::text[]) THEN e."fromId" END)::int AS "joinWhy"
       FROM "Opportunity" o
       JOIN "EvidenceEdge" e ON e."toType" = 'opportunity' AND e."toId" = o."id" AND e."relation" = 'supporting'
       JOIN "EvidenceRecord" r ON r."id" = e."fromId"
      WHERE o."projectId" = $1 AND o."status" = 'detected'
      GROUP BY o."id", o."evidenceCompleteness"`,
    projectId,
    JOIN_CREATORS,
    HOW_KINDS,
    WHY_KINDS
  );

  // Only repairs, never downgrades: the stored leg may be a detector's own
  // judgement, which the edge kinds cannot reproduce. A row that the join gave a
  // missing leg is "both", and that is the only thing this script writes.
  const repair = rows
    .filter((row) => row.evidenceCompleteness !== "both")
    .filter((row) => {
      const hasHow = row.evidenceCompleteness === "how" || row.joinHow > 0;
      const hasWhy = row.evidenceCompleteness === "why" || row.joinWhy > 0;
      return hasHow && hasWhy;
    })
    .map((row) => ({ id: row.id, from: row.evidenceCompleteness, to: "both" }));
  process.stdout.write(`${rows.length} detected opportunities, ${repair.length} regain a leg\n`);
  for (const row of repair.slice(0, 20)) process.stdout.write(`  ${row.id}  ${row.from} -> both\n`);

  if (apply && repair.length > 0) {
    for (const row of repair) {
      await db.opportunity.update({ where: { id: row.id }, data: { evidenceCompleteness: "both" } });
    }
    process.stdout.write(`applied ${repair.length}\n`);
  } else if (repair.length > 0) {
    process.stdout.write("dry run: pass --apply to write\n");
  }
  await db.$disconnect();
}

main();
