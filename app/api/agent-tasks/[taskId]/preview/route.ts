import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const artifact = await db.agentTaskArtifact.findFirst({
    where: { taskId, kind: "preview_html" },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  if (!artifact?.content) return Response.json({ error: "Preview not found" }, { status: 404 });
  return new Response(artifact.content, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; font-src https: data:; connect-src https:",
    },
  });
}
