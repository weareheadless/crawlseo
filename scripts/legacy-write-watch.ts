/**
 * Wave 6 step 2 watcher.
 *
 * The static audit (scripts/legacy-writer-audit.ts) says what *could* write a
 * legacy table. This says what *did*: it reads the database and reports
 *   - any legacy rows created in the window,
 *   - crawls that finished without a CRAWL job, i.e. run outside the queue.
 *
 * The second check exists because an unidentified writer was observed producing
 * 242 legacy actions from five crawls that had no job rows at all. Once the
 * cause is known and removed, this stays as the standing proof for step 2.
 *
 *   npx tsx scripts/legacy-write-watch.ts [--hours 6]
 */

import { PrismaClient } from "@prisma/client";

type LegacyTable = "ResearchAction" | "ResearchRun" | "ResearchFinding" | "SeoResearchRun" | "SeoResearchTask" | "ArticleKeywordResearchRun" | "PrelaunchResearchRequest";

export type WatchReport = {
  windowHours: number;
  legacyCreates: Array<{ table: LegacyTable; created: number; newest: Date | null; owners: string[] }>;
  crawlsFinished: number;
  crawlJobsCreated: number;
  /** Crawls that finished with no CRAWL job in the window: run outside the queue. */
  outOfBandCrawls: number;
  clean: boolean;
};

export async function watchLegacyWrites(db: PrismaClient, opts: { hours?: number; now?: Date } = {}): Promise<WatchReport> {
  const hours = opts.hours ?? 6;
  const since = new Date((opts.now ?? new Date()).getTime() - hours * 3_600_000);

  const tables: Array<{ table: LegacyTable; model: string }> = [
    { table: "ResearchAction", model: "researchAction" },
    { table: "ResearchRun", model: "researchRun" },
    { table: "ResearchFinding", model: "researchFinding" },
    { table: "SeoResearchRun", model: "seoResearchRun" },
    { table: "SeoResearchTask", model: "seoResearchTask" },
    { table: "ArticleKeywordResearchRun", model: "articleKeywordResearchRun" },
    { table: "PrelaunchResearchRequest", model: "prelaunchResearchRequest" },
  ];

  const legacyCreates: WatchReport["legacyCreates"] = [];
  for (const { table, model } of tables) {
    const delegate = (db as unknown as Record<string, { findMany?: (args: unknown) => Promise<Array<{ createdAt: Date; owner?: string | null }>> }>)[model];
    if (!delegate?.findMany) continue;
    const rows = await delegate.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, ...(model === "researchAction" ? { owner: true } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    if (rows.length === 0) continue;
    legacyCreates.push({
      table,
      created: rows.length,
      newest: rows[0].createdAt,
      owners: [...new Set(rows.map((row) => row.owner).filter((owner): owner is string => Boolean(owner)))],
    });
  }

  const [crawls, crawlJobs] = await Promise.all([
    db.crawl.findMany({ where: { finishedAt: { gte: since } }, select: { id: true, finishedAt: true } }),
    // A backlogged job is claimed long after it was created, so match on when the
    // job was last touched, not when it was queued.
    db.job.findMany({ where: { kind: "CRAWL", updatedAt: { gte: since } }, select: { id: true, updatedAt: true } }),
  ]);

  const crawlsFinished = crawls.length;
  const crawlJobsCreated = crawlJobs.length;

  // A crawl with no job touched within two minutes of its finish ran outside the
  // queue. Comparing against jobs *created* in the window would flag every
  // backlogged crawl, which is normal behaviour.
  const outOfBandCrawls = crawls.filter(
    (crawl) =>
      !crawl.finishedAt ||
      !crawlJobs.some((job) => Math.abs(job.updatedAt.getTime() - crawl.finishedAt!.getTime()) <= 120_000)
  ).length;

  return {
    windowHours: hours,
    legacyCreates,
    crawlsFinished,
    crawlJobsCreated,
    outOfBandCrawls,
    // Clean means: no legacy rows created and no crawl ran outside the queue.
    clean: legacyCreates.length === 0 && outOfBandCrawls === 0,
  };
}

if (process.argv[1]?.endsWith("legacy-write-watch.ts")) {
  const index = process.argv.indexOf("--hours");
  const hours = index >= 0 ? Number(process.argv[index + 1]) : 6;
  const db = new PrismaClient();
  watchLegacyWrites(db, { hours })
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.clean) {
        process.stderr.write(
          "\nNot clean: legacy rows are still being created, or a crawl ran outside the job queue. See docs/wave6-cleanup-ledger.md.\n"
        );
        process.exitCode = 2;
      }
    })
    .catch((error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
