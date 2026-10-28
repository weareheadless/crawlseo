import { getUserIdFromCookies } from "@/lib/session-helper";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { getWorkData } from "@/lib/work/service";
import { Workbench } from "@/components/work/workbench";
import { keywordEvidenceForAction, sourceIdsForAction } from "@/lib/research/evidence";
import { opportunityPriorityForAction } from "@/lib/ai-seo/opportunity-priority";
import { actionDimensions, actionDimension, type ActionDimension } from "@/lib/work/categories";
import { PipelineNavigation, PipelineStageContext } from "@/components/pipeline/pipeline-navigation";

interface Props {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ tab?: string; dimension?: string; state?: string; actionId?: string }>;
}


function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export default async function WorkPage({ params, searchParams }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const [data, query] = await Promise.all([getWorkData(siteId), searchParams]);
  const dimension = actionDimensions.includes(query.dimension as ActionDimension) ? query.dimension as ActionDimension : "all";

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
      <div className="mb-5 space-y-3">
        <PipelineNavigation siteId={siteId} currentStage="work" />
        <PipelineStageContext siteId={siteId} currentStage="work" />
      </div>
      {query.actionId && (
        <section className="panel mb-5 flex flex-wrap items-center justify-between gap-3 p-4" aria-label="Selected action">
          <p className="text-sm">Selected action preserved from the previous workspace.</p>
          <Link className="text-sm font-medium text-primary underline" href={`/sites/${siteId}/actions/${encodeURIComponent(query.actionId)}`}>
            Open selected action
          </Link>
        </section>
      )}
      <Workbench
        siteId={siteId}
        initialDimension={dimension}
        initialState={query.state ?? "all"}
        actions={data.actions.map((action) => ({
          id: action.id,
          title: action.title,
          source: action.source,
          kind: action.kind,
          dimension: actionDimension(action),
          format: action.format,
          status: action.status,
          priority: action.priority,
          targetUrl: action.targetUrl,
          primaryQuery: action.primaryQuery,
          recommendation: action.recommendation,
          createdAt: action.createdAt.toISOString(),
          evidenceSources: sourceIdsForAction(action).length,
          keyword: keywordEvidenceForAction(action.evidence),
          opportunity: opportunityPriorityForAction(action),
          editorialDecision: typeof (action.evidence as Record<string, unknown> | null)?.editorial === "object"
            ? String(((action.evidence as Record<string, unknown>).editorial as Record<string, unknown>).decision ?? "")
            : null,
          examples: Array.isArray(record(action.evidence).examples)
            ? (record(action.evidence).examples as unknown[])
              .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
              .map((value) => ({
                url: typeof value.url === "string" ? value.url : "",
                title: typeof value.title === "string" ? value.title : null,
                statusCode: typeof value.statusCode === "number" ? value.statusCode : null,
              }))
              .filter((value) => value.url)
              .slice(0, 3)
            : [],
          drafts: action._count.drafts,
          agentTasks: action._count.agentTasks,
          deliveries: action._count.deliveries,
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
      {data.prelaunchRuns.length > 0 && <section className="panel mt-5 p-4"><h2 className="font-heading text-lg font-semibold">Prelaunch SEO research</h2><p className="mt-1 text-sm text-muted-foreground">Stored keyword results and their derived Actions.</p>{data.prelaunchRuns.map((run) => <p key={run.id} className="mt-2 text-sm"><Link className="text-primary underline" href={`/projects/${data.site.projectId}/prelaunch/${run.id}`}>{run.periodStart.toISOString().slice(0, 7)} · {run.status.toLowerCase()} · SEO research</Link></p>)}</section>}
    </div>
  );
}
