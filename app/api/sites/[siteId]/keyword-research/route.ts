import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { cachedKeywordReport, getLatestResearchReport } from "@/lib/dataforseo/research";
import { fetchSuggestions } from "@/lib/google/autocomplete";
import { resolveDataForSeoReadiness } from "@/lib/dataforseo/readiness";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findFirst({
      where: { id: siteId, userId },
      select: { userId: true, projectId: true, domain: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    await resolveDataForSeoReadiness({ userId, projectId: site.projectId });

    const url = new URL(req.url);
    const runId = url.searchParams.get("runId");
    if (runId) {
      const run = await db.articleKeywordResearchRun.findFirst({ where: { id: runId, siteId }, select: { status: true, result: true, errorCode: true } });
      if (!run) return Response.json({ error: "Research run not found" }, { status: 404 });
      if (run.status !== "COMPLETED") return Response.json({ error: run.status === "FAILED" ? `Research run failed: ${run.errorCode ?? "UNKNOWN_ERROR"}` : "Research run is not complete" }, { status: 409 });
      return Response.json({ source: "dataforseo", keywords: Array.isArray(run.result) ? run.result : [] });
    }
    const query = url.searchParams.get("q");
    if (!query) {
      return Response.json({ error: "Missing query parameter: q" }, { status: 400 });
    }

    // DataForSEO is paid and only runs inside Ada's monthly batch. The dashboard
    // reads that persisted batch and falls back to free autocomplete.
    const latest = site.projectId ? await getLatestResearchReport(site.projectId) : null;
    const dfResults = cachedKeywordReport(latest?.report, query);

    if (dfResults !== null) {
      return Response.json({
        source: "dataforseo",
        research_report_id: latest?.report_id ?? null,
        keywords: dfResults,
      });
    }

    // Fallback to Google Autocomplete
    const suggestions = await fetchSuggestions(query);
    return Response.json({
      source: "autocomplete",
      keywords: suggestions.map((s) => ({
        keyword: s,
        volume: null,
        difficulty: null,
        cpc: null,
        competition: null,
        trend: null,
      })),
    });
  } catch (error) {
    console.error("Keyword research error:", error);
    return Response.json(
      { error: "Keyword research failed" },
      { status: 500 }
    );
  }
}
