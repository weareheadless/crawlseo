import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { cachedBacklinksReport, getLatestResearchReport } from "@/lib/dataforseo/research";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, projectId: true, domain: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    // Backlink profiles are not part of the fixed monthly package. Read the
    // persisted summary and use crawl links for the optional profile view.
    const latest = site.projectId ? await getLatestResearchReport(site.projectId) : null;
    const overview = cachedBacklinksReport(latest?.report, site.domain);

    if (overview !== null) {
      return Response.json({
        source: "dataforseo",
        research_report_id: latest?.report_id ?? null,
        overview,
        backlinks: [],
      });
    }

    // Fallback: external links from our own crawl data
    const latestCrawl = await db.crawl.findFirst({
      where: { siteId, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });

    if (latestCrawl) {
      const externalLinks = await db.auditLink.findMany({
        where: { crawlId: latestCrawl.id, isInternal: false },
        take: limit,
        skip: offset,
        select: {
          sourceUrl: true,
          targetUrl: true,
          anchorText: true,
          isNofollow: true,
        },
      });

      return Response.json({
        source: "crawl",
        overview: null,
        backlinks: externalLinks.map((link) => ({
          referringDomain: "",
          sourceUrl: link.sourceUrl,
          targetUrl: link.targetUrl,
          anchorText: link.anchorText ?? "",
          dofollow: !link.isNofollow,
          firstSeen: null,
          lastSeen: null,
        })),
      });
    }

    return Response.json({
      source: "none",
      overview: null,
      backlinks: [],
    });
  } catch (error) {
    console.error("Backlinks error:", error);
    return Response.json({ error: "Backlinks fetch failed" }, { status: 500 });
  }
}
