import { getUserIdFromCookies } from "@/lib/session-helper";
import { generateDraftForAction } from "@/lib/research/content";
import { ContentWriterError } from "@/lib/ai-seo/writer";
import { ResearchServiceError } from "@/lib/research/service";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ actionId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { actionId } = await params;
  let instructions = "";
  try {
    const body = await req.json() as { instructions?: unknown };
    instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 2_000) : "";
  } catch {
    // Empty body is valid.
  }

  try {
    const draft = await generateDraftForAction(actionId, instructions || undefined);
    return Response.json({
      draft: {
        id: draft.id,
        title: draft.title,
        slug: draft.slug,
        format: draft.format,
        actionId: draft.actionId,
      },
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
