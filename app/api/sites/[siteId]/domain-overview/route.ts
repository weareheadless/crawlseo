import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { cachedBacklinksReport, cachedDomainReport, getLatestResearchReport } from "@/lib/dataforseo/research";
import { getSitePeriodMetrics } from "@/lib/seo-metrics";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findFirst({
      where: { id: siteId, userId },
      select: { userId: true, projectId: true, domain: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const targetDomain = site.domain;

    // DataForSEO is populated by Ada's bounded monthly batch. Never spend a
    // paid task from a dashboard read.
    const latest = site.projectId ? await getLatestResearchReport(site.projectId) : null;
    const domainData = cachedDomainReport(latest?.report, targetDomain);
    const backlinksData = cachedBacklinksReport(latest?.report, targetDomain);

    if (domainData !== null) {
      return Response.json({
        source: "dataforseo",
        research_report_id: latest?.report_id ?? null,
        domain: targetDomain,
        overview: domainData,
        backlinks: backlinksData,
      });
    }

    // Fallback to GSC data
    const metrics = await getSitePeriodMetrics(siteId, 28);

    const keywordCount = await db.keyword.groupBy({
      by: ["query"],
      where: {
        siteId,
        date: { gte: new Date(Date.now() - 28 * 86400000) },
      },
    });

    return Response.json({
      source: "gsc",
      domain: targetDomain,
      overview: {
        organicKeywords: keywordCount.length,
        organicTraffic: metrics.current.clicks,
        organicCost: null,
        backlinks: null,
        referringDomains: null,
      },
      backlinks: null,
      metrics,
    });
  } catch (error) {
    console.error("Domain overview error:", error);
    return Response.json(
      { error: "Domain overview failed" },
      { status: 500 }
    );
  }
}
