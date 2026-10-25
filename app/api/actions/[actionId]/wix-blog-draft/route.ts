import { getUserIdFromCookies } from "@/lib/session-helper";
import { generateWixBlogUpdateDraftForAction } from "@/lib/research/content";
import { ContentWriterError } from "@/lib/ai-seo/writer";
import { ResearchServiceError } from "@/lib/research/service";
import { WixBlogDeliveryError } from "@/lib/delivery/wix-blog";
import { userOwnsResearchAction } from "@/lib/auth/research-action-access";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ actionId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { actionId } = await params;
  if (!(await userOwnsResearchAction(actionId, userId))) {
    return Response.json({ error: "Action not found" }, { status: 404 });
  }
  try {
    const draft = await generateWixBlogUpdateDraftForAction(actionId);
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
    if (error instanceof ContentWriterError || error instanceof WixBlogDeliveryError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    console.error("Wix Blog update draft error:", error);
    return Response.json({ error: "Failed to generate the Wix Blog update" }, { status: 500 });
  }
}
