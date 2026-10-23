import { getUserIdFromCookies } from "@/lib/session-helper";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { getWorkData } from "@/lib/work/service";
import { Workbench } from "@/components/work/workbench";

interface Props {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ tab?: string }>;
}

const allowedTabs = new Set(["inbox", "actions", "drafts", "agent tasks"]);

export default async function WorkPage({ params, searchParams }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const [data, query] = await Promise.all([getWorkData(siteId), searchParams]);
  const tab = allowedTabs.has(query.tab ?? "") ? query.tab as "inbox" | "actions" | "drafts" | "agent tasks" : "inbox";

  return (
    <div>
      <PageHeader
        eyebrow={data.site.domain}
        title="Work"
        description="One queue for research findings, content drafts, implementation tasks, and delivery."
        actions={
          <div className="flex items-center gap-2">
            <DataLagBadge />
            <Link
              href={`/sites/${siteId}/research`}
              className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              Research
            </Link>
          </div>
        }
      />
      <Workbench
        siteId={siteId}
        initialTab={tab}
        actions={data.actions.map((action) => ({
          id: action.id,
          title: action.title,
          source: action.source,
          kind: action.kind,
          format: action.format,
          status: action.status,
          priority: action.priority,
          targetUrl: action.targetUrl,
          primaryQuery: action.primaryQuery,
          recommendation: action.recommendation,
          createdAt: action.createdAt.toISOString(),
          drafts: action._count.drafts,
          agentTasks: action._count.agentTasks,
          deliveries: action._count.deliveries,
        }))}
        drafts={data.drafts.map((draft) => ({
          id: draft.id,
          actionId: draft.actionId,
          title: draft.title,
          format: draft.format,
          status: draft.status,
          createdAt: draft.createdAt.toISOString(),
        }))}
        agentTasks={data.agentTasks.map((task) => ({
          id: task.id,
          actionId: task.actionId,
          actionTitle: task.action?.title ?? null,
          title: task.title,
          status: task.status,
          route: task.route,
          createdAt: task.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
