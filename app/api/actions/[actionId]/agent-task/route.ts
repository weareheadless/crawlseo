import { getUserIdFromCookies } from "@/lib/session-helper";
import { createAgentTaskForAction } from "@/lib/agent-tasks/service";
import { ResearchServiceError } from "@/lib/research/service";
import { userOwnsResearchAction } from "@/lib/auth/research-action-access";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ actionId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { actionId } = await params;
  if (!(await userOwnsResearchAction(actionId, userId))) {
    return Response.json({ error: "Action not found" }, { status: 404 });
  }
  let instructions = "";
  try {
    const body = await req.json() as { instructions?: unknown };
    instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 4_000) : "";
  } catch {
    // Empty body is valid.
  }

  try {
    const task = await createAgentTaskForAction(actionId, instructions || undefined);
    return Response.json({ task }, { status: 201 });
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent task create error:", error);
    return Response.json({ error: "Failed to create agent task" }, { status: 500 });
  }
}
