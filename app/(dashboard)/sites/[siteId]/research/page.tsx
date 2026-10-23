import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { listResearchActions, listResearchRuns } from "@/lib/research/service";
import { listAgentTasks } from "@/lib/agent-tasks/service";
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

  const [runs, actions, agentTasks] = await Promise.all([
    listResearchRuns(siteId),
    listResearchActions(siteId, { limit: 100 }),
    listAgentTasks(siteId),
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
          errorCode: run.errorCode,
          createdAt: run.createdAt.toISOString(),
        }))}
        initialAgentTasks={agentTasks.map((task) => ({
          id: task.id,
          actionId: task.actionId,
          title: task.title,
          status: task.status,
          goal: task.goal,
          route: task.route,
          repoPath: task.repoPath,
          branch: task.branch,
          prompt: task.prompt,
          errorCode: task.errorCode,
          createdAt: task.createdAt.toISOString(),
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
