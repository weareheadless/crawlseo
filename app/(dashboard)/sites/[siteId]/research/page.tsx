import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { listResearchActions, listResearchRuns } from "@/lib/research/service";
import { ResearchWorkbench } from "@/components/research/research-workbench";

interface Props {
  params: Promise<{ siteId: string }>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export default async function ResearchPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true },
  });
  if (!site) redirect("/sites");

  const [runs, actions] = await Promise.all([
    listResearchRuns(siteId),
    listResearchActions(siteId, { limit: 100 }),
  ]);

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Research & Actions"
        description="Evidence-backed market research, findings, and the central website work queue."
        actions={<DataLagBadge />}
      />
      <ResearchWorkbench
        siteId={siteId}
        initialRuns={runs.map((run) => ({
          id: run.id,
          title: run.title,
          kind: run.kind,
          trigger: run.trigger,
          status: run.status,
          topics: strings(run.topics),
          providerSet: strings(run.providerSet),
          sourceCount: run.sourceCount,
          findingCount: run.findingCount,
          actionCount: run.actionCount,
          createdAt: run.createdAt.toISOString(),
        }))}
        initialActions={actions.map((action) => ({
          id: action.id,
          title: action.title,
          source: action.source,
          kind: action.kind,
          format: action.format,
          recommendation: action.recommendation,
          status: action.status,
          priority: action.priority,
          automationMode: action.automationMode,
          targetUrl: action.targetUrl,
          primaryQuery: action.primaryQuery,
          createdAt: action.createdAt.toISOString(),
          drafts: action._count.drafts,
          deliveries: action._count.deliveries,
        }))}
      />
    </div>
  );
}
