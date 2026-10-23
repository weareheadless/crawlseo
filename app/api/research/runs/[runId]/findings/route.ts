import { getUserIdFromCookies } from "@/lib/session-helper";
import { ingestResearchFinding, ResearchServiceError } from "@/lib/research/service";
import { ingestResearchFindingSchema } from "@/lib/research/types";
import { ZodError } from "zod";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  try {
    const input = ingestResearchFindingSchema.parse(await req.json());
    const finding = await ingestResearchFinding(runId, input);
    return Response.json({ finding }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid finding" }, { status: 400 });
    }
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Research finding ingest error:", error);
    return Response.json({ error: "Failed to store research finding" }, { status: 500 });
  }
}
