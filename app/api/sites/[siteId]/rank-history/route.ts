import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { buildRankHistory } from "@/lib/funnel/metric-semantics";

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
      select: { userId: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const query = url.searchParams.get("query");
    const days = parseInt(url.searchParams.get("days") || "90", 10);

    if (!query) {
      return Response.json(
        { error: "Missing required param: query" },
        { status: 400 }
      );
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    // Fetch from both Keyword table and RankSnapshot in parallel
    const [keywordRows, snapshots] = await Promise.all([
      db.keyword.findMany({
        where: {
          siteId,
          query,
          date: { gte: startDate },
        },
        select: {
          date: true,
          position: true,
          clicks: true,
          impressions: true,
        },
        orderBy: { date: "asc" },
      }),
      db.rankSnapshot.findMany({
        where: {
          siteId,
          query,
          date: { gte: startDate },
        },
        select: {
          date: true,
          position: true,
          clicks: true,
          impressions: true,
        },
        orderBy: { date: "asc" },
      }),
    ]);

    // DS-05: no unlabelled precedence overlay. Search Console average position
    // and a sampled SERP rank are different measurements, so both series are
    // returned tagged rather than one silently overwriting the other.
    const history = buildRankHistory({ gsc: keywordRows, sampled: snapshots });

    return Response.json(history);
  } catch (error) {
    console.error("Rank history error:", error);
    return Response.json(
      { error: "Failed to load rank history" },
      { status: 500 }
    );
  }
}
