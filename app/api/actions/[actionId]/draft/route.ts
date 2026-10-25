import { getUserIdFromCookies } from "@/lib/session-helper";
import { generateDraftForAction } from "@/lib/research/content";
import { ContentWriterError } from "@/lib/ai-seo/writer";
import { ResearchServiceError } from "@/lib/research/service";
import { createAgentTaskIfEligible } from "@/lib/agent-tasks/service";
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
  try {
    const body = await req.json() as { instructions?: unknown };
    instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 2_000) : "";
  } catch {
    // Empty body is valid.
  }

  try {
    const draft = await generateDraftForAction(actionId, instructions || undefined);
    let agentTask = null;
    let agentTaskError: string | null = null;
    try {
      const result = await createAgentTaskIfEligible(
        actionId,
        "Created automatically after the content draft. Review the diff and evidence before updating.",
      );
      if (result.created) agentTask = result.task;
      else agentTaskError = result.reason;
    } catch (error) {
      agentTaskError = error instanceof Error ? error.message : "agent task creation failed";
    }
    return Response.json({
      draft: {
        id: draft.id,
        title: draft.title,
        slug: draft.slug,
        format: draft.format,
        actionId: draft.actionId,
      },
      agentTask,
      agentTaskError,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ContentWriterError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    console.error("Action draft error:", error);
    return Response.json({ error: "Failed to generate draft" }, { status: 500 });
  }
}
