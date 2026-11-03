/**
 * Wave 0.5, DS-06 producer: AI visibility from ChatGPT with web search.
 *
 * Thin wrapper over `lib/dataforseo/collection.ts`. One call per question
 * (~$0.027 with web search; the no-search variant cannot cite anyone, so it
 * cannot measure visibility), reserved against the project's DS-08 allowance.
 *
 *   npx tsx scripts/ds-wave05-ai.ts --site <siteId> [--questions 8] [--dry-run]
 */

import { PrismaClient } from "@prisma/client";

import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";
import { collectAiVisibility } from "@/lib/dataforseo/collection";

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const dryRun = argv.includes("--dry-run");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--dry-run") continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  const siteId = values.get("site");
  if (!siteId) throw new Error("--site <siteId> is required");
  return {
    siteId,
    questions: Math.max(1, Math.min(Number(values.get("questions") ?? 8), 30)),
    language: values.get("language") ?? "fr",
    country: values.get("country") ?? "FR",
    dryRun,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  const site = await db.site.findUniqueOrThrow({ where: { id: args.siteId }, select: { id: true, domain: true, projectId: true } });
  if (!site.projectId) throw new Error("site is not attached to a project");
  const locale = await resolveDataForSeoLocale(site.projectId, args.language, args.country);

  // Prefer the question set when it exists: those are the questions the business
  // is meant to be cited for, not just the queries that happen to get impressions.
  const coverage = await db.evidenceRecord.findMany({
    where: { projectId: site.projectId, kind: "question_coverage", supersededById: null },
    select: { dimensions: true },
    take: args.questions,
  });
  const fromSet = coverage
    .map((row) => (row.dimensions as { question?: string } | null)?.question)
    .filter((question): question is string => Boolean(question));
  let questions = fromSet;
  if (questions.length === 0) {
    const ranks = await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, kind: "keyword_rank", supersededById: null },
      select: { dimensions: true, metrics: true },
    });
    const byQuery = new Map<string, number>();
    for (const row of ranks) {
      const query = (row.dimensions as { query?: string } | null)?.query;
      if (!query) continue;
      const impressions = Number((row.metrics as Record<string, { value?: number }> | null)?.["first_party:impressions"]?.value ?? 0);
      byQuery.set(query, (byQuery.get(query) ?? 0) + impressions);
    }
    questions = [...byQuery.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.questions).map(([query]) => query);
  }
  if (questions.length === 0) throw new Error("no questions to ask");

  process.stdout.write(`${site.domain}: ${questions.length} questions, ${locale.languageCode}/${locale.locationCode}${args.dryRun ? " (dry run)" : ""}\n`);
  if (args.dryRun) {
    for (const question of questions) process.stdout.write(`  ${question}\n`);
    await db.$disconnect();
    return;
  }

  const result = await collectAiVisibility(db as never, {
    projectId: site.projectId,
    siteId: site.id,
    queries: questions,
    languageCode: locale.languageCode,
    locationCode: locale.locationCode,
    domain: site.domain,
  });
  process.stdout.write(
    JSON.stringify({ questions: questions.length, stored: result.evidence.length, costUsd: result.spentMicros / 1_000_000 }, null, 1) + "\n"
  );
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
