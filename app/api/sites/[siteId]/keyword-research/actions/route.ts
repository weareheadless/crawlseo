import { getUserIdFromCookies } from "@/lib/session-helper";
import { queueKeywordAction } from "@/lib/research/keyword-actions";
import { z } from "zod";
import { ZodError } from "zod";

const schema = z.object({
  keyword: z.string().trim().min(2).max(300),
  volume: z.number().nonnegative().nullable().optional(),
  difficulty: z.number().min(0).max(100).nullable().optional(),
  cpc: z.number().nonnegative().nullable().optional(),
  competition: z.number().nullable().optional(),
  intent: z.string().trim().max(60).nullable().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  try {
    const input = schema.parse(await req.json());
    const result = await queueKeywordAction(siteId, input, userId);
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid keyword" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "Site not found") {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("Keyword action error:", error);
    return Response.json({ error: "Failed to queue keyword action" }, { status: 500 });
  }
}
