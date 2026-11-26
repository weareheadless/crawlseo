#!/usr/bin/env node
/**
 * Un-retire the opportunities the topic-map retirement removed without a replacement.
 *
 * The retirement parks a legacy row only when the topic map can express the same finding.
 * Before that coverage test existed it parked every legacy row, so rows of types the map
 * cannot emit were filed as "superseded by the topic-map pipeline" — a successful migration
 * that had in fact deleted whole kinds of analysis.
 *
 * This restores exactly those rows: system-parked by `topic-map-v1`, of a type the map cannot
 * produce, untouched since. It does not touch a row a person decided, and it does not touch a
 * type the map does cover, because for those the retirement was correct.
 *
 *   npx tsx scripts/restore-wrongly-retired.ts --dry-run
 *   npx tsx scripts/restore-wrongly-retired.ts --apply
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { PrismaClient } from "@prisma/client";

import { TYPES_THE_TOPIC_MAP_PRODUCES } from "@/lib/funnel/backfill";

const PARK_REASON = "superseded by the topic-map pipeline";
const SYSTEM_DECIDER = "topic-map-v1";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = new PrismaClient();
  const covered = [...TYPES_THE_TOPIC_MAP_PRODUCES] as never[];

  const rows = await db.opportunity.findMany({
    where: {
      parkReason: PARK_REASON,
      decidedBy: SYSTEM_DECIDER,
      type: { notIn: covered },
    },
    select: { id: true, type: true, title: true, scoreValue: true },
  });

  const byType = new Map<string, number>();
  for (const row of rows) byType.set(row.type, (byType.get(row.type) ?? 0) + 1);

  console.log(`rows wrongly retired: ${rows.length}`);
  for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${type}`);
  }

  if (rows.length === 0) {
    console.log("nothing to restore");
    await db.$disconnect();
    return;
  }
  if (!apply) {
    console.log("\ndry run; re-run with --apply to restore");
    await db.$disconnect();
    return;
  }

  const result = await db.opportunity.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { status: "detected", parkReason: null, decidedBy: null, decidedAt: null },
  });
  console.log(`\nrestored: ${result.count}`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
