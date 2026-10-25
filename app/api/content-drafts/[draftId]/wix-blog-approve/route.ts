import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { approveWixBlogUpdateForDraft, WixBlogDeliveryError } from "@/lib/delivery/wix-blog";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { draftId } = await params;
  const draft = await db.contentDraft.findUnique({
    where: { id: draftId },
    select: { site: { select: { userId: true } } },
  });
  if (!draft || draft.site.userId !== userId) return Response.json({ error: "Draft not found" }, { status: 404 });
  try {
    const approval = await approveWixBlogUpdateForDraft(draftId, userId);
    return Response.json({ approval });
  } catch (error) {
    if (error instanceof WixBlogDeliveryError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Wix Blog candidate approval error:", error);
    return Response.json({ error: "Failed to approve the Wix Blog candidate" }, { status: 500 });
  }
}
