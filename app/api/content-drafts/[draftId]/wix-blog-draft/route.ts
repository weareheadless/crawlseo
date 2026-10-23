import { getUserIdFromCookies } from "@/lib/session-helper";
import { createWixBlogDraftForDraft, WixBlogDeliveryError } from "@/lib/delivery/wix-blog";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { draftId } = await params;
  try {
    const delivery = await createWixBlogDraftForDraft(draftId);
    return Response.json({ delivery }, { status: 201 });
  } catch (error) {
    if (error instanceof WixBlogDeliveryError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Wix Blog delivery error:", error);
    return Response.json({ error: "Failed to create Wix Blog draft" }, { status: 500 });
  }
}
