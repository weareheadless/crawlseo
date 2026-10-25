import { getUserIdFromCookies } from "@/lib/session-helper";
import { listAgentTasks } from "@/lib/agent-tasks/service";
import { userOwnsSite } from "@/lib/auth/research-action-access";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  return Response.json({ tasks: await listAgentTasks(siteId) });
}
