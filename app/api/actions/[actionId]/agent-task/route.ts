import { getUserIdFromCookies } from "@/lib/session-helper";
import { createAgentTaskForAction } from "@/lib/agent-tasks/service";
import { ResearchServiceError } from "@/lib/research/service";
import { researchActionAccess } from "@/lib/auth/research-action-access";
import { EXTERNAL_EXECUTION_MESSAGE } from "@/lib/research/execution-authority";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ actionId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { actionId } = await params;
  const access = await researchActionAccess(actionId, userId);
  if (access === "missing") {
    return Response.json({ error: "Action not found" }, { status: 404 });
  }
  if (access === "external") {
    return Response.json({ error: EXTERNAL_EXECUTION_MESSAGE }, { status: 409 });
  }
  let instructions = "";
  let lane: "page" | "article" | undefined;
  let route: string | null = null;
  try {
    const body = await req.json() as { instructions?: unknown; lane?: unknown; route?: unknown };
    instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 4_000) : "";
    lane = body.lane === "page" || body.lane === "article" ? body.lane : undefined;
    route = typeof body.route === "string" && body.route.trim() ? body.route.trim().slice(0, 500) : null;
  } catch {
    // Empty body is valid.
  }

  try {
    const task = await createAgentTaskForAction(actionId, instructions || undefined, { lane, route });
    return Response.json({ task }, { status: 201 });
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent task create error:", error);
    return Response.json({ error: "Failed to create agent task" }, { status: 500 });
  }
}
