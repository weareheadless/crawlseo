import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { assertPublicDomain } from "@/lib/crawler/engine";
import { JobKind } from "@prisma/client";
import { enqueueJob } from "@/lib/jobs/queue";
import { ensureDefaultAlerts } from "@/lib/alerts/evaluate";

export async function GET() {
  try {
    const userId = await getUserIdFromCookies();

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sites = await db.site.findMany({
      where: { userId },
      select: {
        id: true,
        domain: true,
        gscProperty: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            keywords: true,
            crawls: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return Response.json(sites);
  } catch (error) {
    console.error("Error fetching sites:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch sites",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromCookies();

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { domain, gscProperty } = (await req.json()) as {
      domain: string;
      gscProperty: string;
    };

    if (!domain || !gscProperty) {
      return Response.json(
        { error: "Missing domain or gscProperty" },
        { status: 400 }
      );
    }

    // Reject domains that resolve to private/internal IPs (SSRF protection)
    try {
      await assertPublicDomain(domain);
    } catch {
      return Response.json(
        { error: "Domain must resolve to a public IP address" },
        { status: 400 }
      );
    }

    // Check if site already exists
    const existing = await db.site.findUnique({
      where: {
        userId_domain: {
          userId,
          domain,
        },
      },
    });

    if (existing) {
      return Response.json(
        { error: "Site already exists" },
        { status: 409 }
      );
    }

    // Create the site
    const site = await db.site.create({
      data: {
        userId,
        domain,
        gscProperty,
      },
      select: {
        id: true,
        domain: true,
        gscProperty: true,
        createdAt: true,
      },
    });

    await ensureDefaultAlerts(userId, site.id);

    await enqueueJob({
      siteId: site.id,
      kind: JobKind.GSC_SYNC,
      payload: { userId, daysBack: 28 },
      idempotencyKey: `site-create:${site.id}:gsc`,
    });

    return Response.json(site, { status: 201 });
  } catch (error) {
    console.error("Error creating site:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to create site",
      },
      { status: 500 }
    );
  }
}
