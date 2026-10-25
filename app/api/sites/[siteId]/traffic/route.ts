import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { getDailyTraffic } from "@/lib/seo-metrics";

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
      select: { userId: true },
    });

    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const url = new URL(_req.url);
    const days = Math.min(
      Math.max(Number(url.searchParams.get("days") || 90), 7),
      180
    );

    const data = await getDailyTraffic(siteId, days);
    return Response.json(data);
  } catch (error) {
    console.error("Error fetching traffic:", error);
    return Response.json({ error: "Failed to load traffic" }, { status: 500 });
  }
}
