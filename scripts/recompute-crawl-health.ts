import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import {
  buildIssuePriorities,
  computeHealthScore,
} from "@/lib/crawler/health";

loadEnvConfig(process.cwd());

const dryRun = process.argv.includes("--dry-run");
const db = new PrismaClient();

async function main() {
  const crawls = await db.crawl.findMany({
    where: { status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: {
      id: true,
      siteId: true,
      pagesFound: true,
      issuesFound: true,
      healthScore: true,
      finishedAt: true,
      site: { select: { domain: true } },
    },
  });

  for (const crawl of crawls) {
    const issues = await db.crawlIssue.findMany({
      where: { crawlId: crawl.id },
      select: { url: true, type: true, severity: true, details: true },
    });
    const healthScore = computeHealthScore(issues, crawl.pagesFound);
    const priorities = buildIssuePriorities(issues, crawl.pagesFound).slice(0, 3);
    console.log(JSON.stringify({
      domain: crawl.site.domain,
      crawlId: crawl.id,
      finishedAt: crawl.finishedAt?.toISOString() ?? null,
      pages: crawl.pagesFound,
      issues: crawl.issuesFound,
      oldScore: crawl.healthScore,
      newScore: healthScore,
      top: priorities.map((item) => ({
        type: item.type,
        severity: item.severity,
        affectedPct: item.affectedPct,
        penalty: item.penalty,
      })),
    }));
    if (!dryRun && healthScore !== crawl.healthScore) {
      await db.crawl.update({
        where: { id: crawl.id },
        data: { healthScore },
      });
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
