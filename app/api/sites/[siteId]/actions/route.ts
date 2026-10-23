import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { createResearchAction, listResearchActions, ResearchServiceError } from "@/lib/research/service";
import { createResearchActionSchema, researchActionStatusSchema } from "@/lib/research/types";
import { ZodError } from "zod";

async function siteExists(siteId: string): Promise<boolean> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true } });
  return Boolean(site);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  if (!(await siteExists(siteId))) {
    return Response.json({ error: "Site not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const requestedStatus = url.searchParams.get("status");
  const parsedStatus = requestedStatus
    ? researchActionStatusSchema.safeParse(requestedStatus.toUpperCase())
    : null;
  if (parsedStatus && !parsedStatus.success) {
    return Response.json({ error: "Invalid action status" }, { status: 400 });
  }
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return Response.json({
    actions: await listResearchActions(siteId, {
      status: parsedStatus?.success ? parsedStatus.data : undefined,
      limit,
    }),
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  try {
    const input = createResearchActionSchema.parse(await req.json());
    const result = await createResearchAction(siteId, input, userId);
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid action" }, { status: 400 });
    }
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Research action create error:", error);
    return Response.json({ error: "Failed to create research action" }, { status: 500 });
  }
}
