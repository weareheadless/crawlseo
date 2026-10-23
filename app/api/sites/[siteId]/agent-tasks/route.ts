import { getUserIdFromCookies } from "@/lib/session-helper";
import { listAgentTasks } from "@/lib/agent-tasks/service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  return Response.json({ tasks: await listAgentTasks(siteId) });
}
