import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { buildRankChart, bucketWeekly, sampledRankSeries } from "@/lib/funnel/rank-series";

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
    const site = await db.site.findFirst({
      where: { id: siteId, userId },
      select: { userId: true, projectId: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const query = url.searchParams.get("query");
    const days = parseInt(url.searchParams.get("days") || "182", 10);

    if (!query) {
      return Response.json(
        { error: "Missing required param: query" },
        { status: 400 }
      );
    }

    const weeks = Math.max(1, Math.round(days / 7));
    const since = new Date(Date.now() - weeks * 7 * 86_400_000);

    // CMP-004: one reader for the weekly series, shared with the cluster page, so
    // the JSON and the rendered chart can never disagree. The weekly buckets are
    // the trend; a sampled SERP is a separate labelled series.
    const daily = await db.keyword.findMany({
      where: { siteId, query, date: { gte: since } },
      select: { date: true, position: true, clicks: true, impressions: true },
      orderBy: { date: "asc" },
    });
    const bucketed = bucketWeekly(daily);
    const sampled = site.projectId
      ? await sampledRankSeries(db, { projectId: site.projectId, queries: [query], weeks })
      : [];

    // DS-05: no unlabelled precedence overlay. Search Console average position
    // and a sampled SERP rank are different measurements, so both series are
    // tagged and the chart draws them separately.
    return Response.json(buildRankChart({ weekly: bucketed.points, sampled, suppressed: bucketed.suppressed }));
  } catch (error) {
    console.error("Rank history error:", error);
    return Response.json(
      { error: "Failed to load rank history" },
      { status: 500 }
    );
  }
}
