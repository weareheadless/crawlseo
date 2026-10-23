import { getUserIdFromCookies } from "@/lib/session-helper";
import { getResearchRun, ResearchServiceError } from "@/lib/research/service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  try {
    return Response.json({ run: await getResearchRun(runId) });
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Research run read error:", error);
    return Response.json({ error: "Failed to load research run" }, { status: 500 });
  }
}
