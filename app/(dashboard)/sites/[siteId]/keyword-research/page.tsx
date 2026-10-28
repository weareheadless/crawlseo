import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { KeywordResearchClient } from "@/components/research/keyword-research-client";
import { resolveDataForSeoReadiness } from "@/lib/dataforseo/readiness";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function KeywordResearchPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true, projectId: true },
  });
  if (!site) redirect("/sites");

  const readiness = await resolveDataForSeoReadiness({ userId, projectId: site.projectId });
  const runs = await db.articleKeywordResearchRun.findMany({ where: { siteId }, orderBy: { requestedAt: "desc" }, take: 50 });

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Keyword Research"
        description="Discover keyword ideas with search volume, difficulty, and CPC data"
      />
      <KeywordResearchClient siteId={siteId} hasDataForSEO={readiness.configured} runs={runs.map((run) => ({ id: run.id, seed: run.seed, kind: run.kind, status: run.status, completedAt: run.completedAt?.toISOString() ?? null, costMicros: run.costMicros, errorCode: run.errorCode, result: run.result }))} />
    </div>
  );
}
