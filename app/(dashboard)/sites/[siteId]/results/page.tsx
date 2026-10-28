import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { PipelineNavigation } from "@/components/pipeline/pipeline-navigation";
import { ResultsPanel } from "@/components/results/results-panel";
import { readPipelineResults } from "@/lib/pipeline/results";

export default async function ResultsPage({ params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, domain: true, projectId: true } });
  if (!site) redirect("/sites");
  const results = await readPipelineResults(siteId, site.projectId);
  return <div className="space-y-6">
    <PageHeader eyebrow={site.domain} title="Results" description="Recorded delivery and measured observations, with attribution kept explicit." />
    <PipelineNavigation siteId={siteId} currentStage="results" />
    <ResultsPanel siteId={siteId} results={results} />
  </div>;
}
