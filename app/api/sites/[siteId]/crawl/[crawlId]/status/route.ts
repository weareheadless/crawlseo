import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string; crawlId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId, crawlId } = await params;

    const site = await db.site.findFirst({
      where: { id: siteId, userId },
      select: { userId: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const crawl = await db.crawl.findUnique({
      where: { id: crawlId },
      select: {
        id: true,
        siteId: true,
        status: true,
        pagesFound: true,
        issuesFound: true,
        healthScore: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    if (!crawl || crawl.siteId !== siteId) {
      return Response.json({ error: "Crawl not found" }, { status: 404 });
    }

    return Response.json({
      id: crawl.id,
      status: crawl.status,
      pagesFound: crawl.pagesFound,
      issuesFound: crawl.issuesFound,
      healthScore: crawl.healthScore,
      startedAt: crawl.startedAt,
      finishedAt: crawl.finishedAt,
    });
  } catch (error) {
    console.error("Crawl status error:", error);
    return Response.json(
      { error: "Failed to load crawl status" },
      { status: 500 }
    );
  }
}
