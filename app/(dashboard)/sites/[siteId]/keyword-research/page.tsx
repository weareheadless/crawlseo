import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { KeywordResearchClient } from "@/components/research/keyword-research-client";
import { resolveDataForSeoReadiness } from "@/lib/dataforseo/readiness";
import { keywordRowsFromEvidence, shadowRunToScreenRow } from "@/lib/dataforseo/keyword-evidence-view";
import { PipelineNavigation } from "@/components/pipeline/pipeline-navigation";

interface Props {
  params: Promise<{ siteId: string }>;
}

/**
 * DS-02 step 3: this screen reads the unified `ResearchRun` table (kind
 * ARTICLE_KEYWORD) and pulls its rows from the evidence store, so the legacy
 * article run table no longer has a reader.
 */
export default async function KeywordResearchPage({ params, searchParams }: Props & { searchParams: Promise<{ run?: string }> }) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  const { run: requestedRun } = await searchParams;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true, projectId: true },
  });
  if (!site) redirect("/sites");

  const readiness = await resolveDataForSeoReadiness({ userId, projectId: site.projectId });
  const runs = await db.researchRun.findMany({
    where: { siteId, kind: "ARTICLE_KEYWORD" },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, status: true, seed: true, brief: true, createdAt: true,
      completedAt: true, costMicros: true, errorCode: true, providerTaskId: true,
    },
  });
  const chosen = runs.find((run) => run.id === requestedRun) ?? runs.find((run) => run.status === "COMPLETED") ?? null;
  const selectedKeywords = chosen ? await keywordRowsFromEvidence(db, { id: chosen.id, providerTaskId: chosen.providerTaskId }) : null;
  const rows = runs.map((run) =>
    shadowRunToScreenRow(run, run.id === chosen?.id ? selectedKeywords ?? [] : [])
  );

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Keyword Research · stored runs"
        description="Review recorded keyword, SERP and market run results. This page is a research lens, not a paid research runner."
      />
      <div className="mb-4"><PipelineNavigation siteId={siteId} currentStage="evidence" /></div>
      <KeywordResearchClient
        siteId={siteId}
        hasDataForSEO={readiness.configured}
        runs={rows}
        selectedRunId={chosen?.id ?? null}
        selectedResult={selectedKeywords ?? null}
      />
    </div>
  );
}
