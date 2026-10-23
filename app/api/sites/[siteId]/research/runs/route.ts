import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { createResearchRun, listResearchRuns, ResearchServiceError } from "@/lib/research/service";
import { createResearchRunSchema } from "@/lib/research/types";
import { ZodError } from "zod";

async function siteExists(siteId: string): Promise<boolean> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true } });
  return Boolean(site);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  if (!(await siteExists(siteId))) {
    return Response.json({ error: "Site not found" }, { status: 404 });
  }
  const runs = await listResearchRuns(siteId);
  return Response.json({ runs });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  try {
    const input = createResearchRunSchema.parse(await req.json());
    const run = await createResearchRun(siteId, input, userId);
    return Response.json({ run }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid research run" }, { status: 400 });
    }
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Research run create error:", error);
    return Response.json({ error: "Failed to create research run" }, { status: 500 });
  }
}
