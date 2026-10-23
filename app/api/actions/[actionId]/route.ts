import { getUserIdFromCookies } from "@/lib/session-helper";
import { updateResearchAction, ResearchServiceError } from "@/lib/research/service";
import { updateResearchActionSchema } from "@/lib/research/types";
import { ZodError } from "zod";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ actionId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { actionId } = await params;
  try {
    const input = updateResearchActionSchema.parse(await req.json());
    const action = await updateResearchAction(actionId, input, userId);
    return Response.json({ action });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid action update" }, { status: 400 });
    }
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Research action update error:", error);
    return Response.json({ error: "Failed to update research action" }, { status: 500 });
  }
}
