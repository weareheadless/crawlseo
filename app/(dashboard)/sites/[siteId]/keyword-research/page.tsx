import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { KeywordResearchClient } from "@/components/research/keyword-research-client";
import { resolveDataForSeoReadiness } from "@/lib/dataforseo/readiness";
import { keywordRunRows } from "@/lib/dataforseo/keyword-run-view";
import { PipelineNavigation } from "@/components/pipeline/pipeline-navigation";

interface Props {
  params: Promise<{ siteId: string }>;
}

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
  const runs = await db.articleKeywordResearchRun.findMany({ where: { siteId }, orderBy: { requestedAt: "desc" }, take: 50 });
  const chosen = runs.find((run) => run.id === requestedRun) ?? runs.find((run) => run.status === "COMPLETED");

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Keyword Research"
        description="Discover keyword ideas with search volume, difficulty, and CPC data"
      />
      <div className="mb-4"><PipelineNavigation siteId={siteId} currentStage="research" /></div>
      <KeywordResearchClient siteId={siteId} hasDataForSEO={readiness.configured} runs={keywordRunRows(runs)} selectedRunId={chosen?.id ?? null} selectedResult={chosen?.result ?? null} />
    </div>
  );
}
