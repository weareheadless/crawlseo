import { db } from "@/lib/db";
import { getDateRange } from "@/lib/date-utils";
import { getAllOpportunities } from "@/lib/seo-opportunities";
import {
  buildContentActionPlan,
  type ContentActionPlan,
  type PageEvidence,
} from "@/lib/ai-seo/action-plan";

function utcRange(days: number) {
  const { start, end } = getDateRange(days);
  return {
    start: new Date(`${start}T00:00:00.000Z`),
    end: new Date(`${end}T23:59:59.999Z`),
  };
}

export async function getContentActionPlan(
  siteId: string,
  domain: string,
): Promise<ContentActionPlan> {
  const range = utcRange(28);
  const [opportunities, keywordPages] = await Promise.all([
    getAllOpportunities(siteId),
    db.keyword.groupBy({
      by: ["query", "page"],
      where: {
        siteId,
        date: { gte: range.start, lte: range.end },
        page: { not: "" },
      },
      _sum: { impressions: true },
    }),
  ]);

  const targetByQuery = new Map<string, { page: string; impressions: number }>();
  for (const row of keywordPages) {
    if (!row.page) continue;
    const current = targetByQuery.get(row.query);
    const impressions = row._sum.impressions ?? 0;
    if (!current || impressions > current.impressions) {
      targetByQuery.set(row.query, { page: row.page, impressions });
    }
  }

  const queryTargets = Object.fromEntries(
    [...targetByQuery.entries()].map(([query, value]) => [query, value.page]),
  );

  const urls = new Set<string>();
  for (const url of Object.values(queryTargets)) urls.add(url);
  for (const row of opportunities.decay) urls.add(row.url);
  for (const row of opportunities.cannibal) {
    for (const page of row.pages.slice(0, 3)) urls.add(page.url);
  }

  const latestCrawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });

  const pages: Record<string, PageEvidence> = {};
  if (latestCrawl && urls.size > 0) {
    const auditPages = await db.auditPage.findMany({
      where: {
        crawlId: latestCrawl.id,
        url: { in: [...urls].slice(0, 250) },
      },
      select: {
        url: true,
        title: true,
        description: true,
        wordCount: true,
        contentScore: true,
        h1Count: true,
        statusCode: true,
      },
    });
    for (const page of auditPages) {
      pages[page.url] = {
        url: page.url,
        title: page.title ?? "",
        description: page.description ?? "",
        wordCount: page.wordCount,
        contentScore: page.contentScore,
        h1Count: page.h1Count,
        statusCode: page.statusCode,
      };
    }
  }

  return buildContentActionPlan({
    siteId,
    domain,
    striking: opportunities.striking,
    lowCtr: opportunities.lowCtr,
    decay: opportunities.decay,
    cannibal: opportunities.cannibal,
    queryTargets,
    pages,
  });
}
