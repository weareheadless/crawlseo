import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { ensureDefaultAlerts, evaluateAlertsForUser } from "@/lib/alerts/evaluate";

export async function GET() {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const alerts = await db.alert.findMany({
      where: { userId },
      include: { site: { select: { domain: true } } },
      orderBy: { createdAt: "desc" },
    });

    return Response.json(alerts);
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      action?: "evaluate" | "ensure";
      siteId?: string;
    };

    if (body.action === "ensure" && body.siteId) {
      const site = await db.site.findUnique({
        where: { id: body.siteId },
        select: { userId: true },
      });
      if (!site) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      await ensureDefaultAlerts(userId, body.siteId);
      return Response.json({ ok: true });
    }

    const fires = await evaluateAlertsForUser(userId);
    return Response.json({ fires });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Failed" }, { status: 500 });
  }
}
