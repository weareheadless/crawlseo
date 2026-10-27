import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { derivePrelaunchActions } from "@/lib/dataforseo/prelaunch-actions";

export async function POST(_: Request, { params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const userId = await getUserIdFromCookies(); if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { projectId, runId } = await params;
  const project = await db.project.findFirst({ where: { id: projectId, sites: { some: { userId } } }, select: { id: true } });
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  try { return Response.json(await derivePrelaunchActions(projectId, runId)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Failed to derive actions" }, { status: 400 }); }
}
