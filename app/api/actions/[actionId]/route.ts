import { getUserIdFromCookies } from "@/lib/session-helper";
import { updateResearchAction, ResearchServiceError } from "@/lib/research/service";
import { updateResearchActionSchema } from "@/lib/research/types";
import { createAgentTaskIfEligible } from "@/lib/agent-tasks/service";
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

    let agentTask = null;
    let agentTaskError: string | null = null;
    if (input.status === "APPROVED") {
      try {
        const result = await createAgentTaskIfEligible(
          actionId,
          "Created automatically when the action was approved. Review the evidence, then run the agent.",
        );
        if (result.created) agentTask = result.task;
        else agentTaskError = result.reason;
      } catch (error) {
        agentTaskError = error instanceof Error ? error.message : "agent task creation failed";
      }
    }

    return Response.json({ action, agentTask, agentTaskError });
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
