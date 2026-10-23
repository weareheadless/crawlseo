import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { getActionDetail } from "@/lib/work/service";
import { ActionControls } from "@/components/work/action-controls";
import { AgentChat } from "@/components/work/agent-chat";
import { WixBlogDraftButton } from "@/components/work/wix-blog-draft-button";
import { AgentTaskRunButton } from "@/components/work/agent-task-run-button";
import { AgentTaskActions } from "@/components/work/agent-task-actions";

interface Props {
  params: Promise<{ siteId: string; actionId: string }>;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default async function ActionDetailPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId, actionId } = await params;
  if (!userId) redirect("/login");

  let action;
  try {
    action = await getActionDetail(siteId, actionId);
  } catch {
    redirect(`/sites/${siteId}/work`);
  }

  return (
    <div>
      <PageHeader
        eyebrow={action.site.domain}
        title={action.title}
        description={action.recommendation}
        actions={
          <div className="flex items-center gap-2">
            <DataLagBadge />
            <Link
              href={`/sites/${siteId}/work`}
              className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              Back to Work
            </Link>
          </div>
        }
      />

      <div className="mb-5">
        <ActionControls
          actionId={action.id}
          initialStatus={action.status}
          format={action.format}
          targetUrl={action.targetUrl}
          hasDraft={action.drafts.length > 0}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-5">
          <section className="panel p-5">
            <h2 className="font-heading text-lg font-semibold">Evidence and recommendation</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <Fact label="Status" value={action.status.toLowerCase().replaceAll("_", " ")} />
              <Fact label="Priority" value={String(action.priority)} />
              <Fact label="Source" value={action.source} />
              <Fact label="Kind" value={action.kind} />
              <Fact label="Target" value={action.targetUrl || "—"} />
              <Fact label="Query" value={action.primaryQuery || "—"} />
            </div>
            {action.finding && (
              <div className="mt-4 rounded-lg border border-border/60 bg-muted/20 p-3">
                <p className="font-data text-[10px] uppercase text-muted-foreground">{action.finding.type}</p>
                <p className="mt-1 text-sm font-medium">{action.finding.theme}</p>
                <p className="mt-1 text-xs text-muted-foreground">{action.finding.summary}</p>
              </div>
            )}
            <details className="mt-4">
              <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">Raw evidence</summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-[10px] leading-5">
                {json(action.evidence)}
              </pre>
            </details>
          </section>

          <section className="panel p-5">
            <h2 className="font-heading text-lg font-semibold">Content drafts</h2>
            {action.drafts.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No content draft yet.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {action.drafts.map((draft) => (
                  <details key={draft.id} className="rounded-lg border border-border/60 p-3">
                    <summary className="cursor-pointer list-none">
                      <span className="text-sm font-medium">{draft.title}</span>
                      <span className="ml-2 font-data text-[10px] text-muted-foreground">{draft.format} · {draft.createdAt.toLocaleString()}</span>
                    </summary>
                    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-5 text-foreground/80">
                      {draft.markdown}
                    </pre>
                    {draft.format === "article" && (
                      <WixBlogDraftButton
                        draftId={draft.id}
                        existingExternalId={action.deliveries.find((delivery) =>
                          delivery.draftId === draft.id && delivery.platform === "wix_blog")?.externalId ?? null}
                      />
                    )}
                  </details>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="panel overflow-hidden">
          <div className="border-b border-border/60 p-5">
            <h2 className="font-heading text-lg font-semibold">Implementation tasks</h2>
            <p className="mt-1 text-sm text-muted-foreground">Agent work, review notes, and delivery history.</p>
          </div>
          {action.agentTasks.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">No agent task yet.</p>
          ) : (
            <div className="divide-y divide-border/40">
              {action.agentTasks.map((task) => (
                <div key={task.id} className="p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{task.title}</p>
                    <AgentTaskRunButton taskId={task.id} status={task.status} />
                    <AgentTaskActions taskId={task.id} status={task.status} commitSha={task.commitSha} />
                  </div>
                  <p className="mt-1 font-data text-[10px] text-muted-foreground">
                    {task.repoPath}{task.branch ? ` · ${task.branch}` : ""}{task.route ? ` · ${task.route}` : ""}
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">Prompt</summary>
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-[10px] leading-5">
                      {task.prompt}
                    </pre>
                  </details>
                  {task.artifacts.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {task.artifacts.map((artifact) => (
                        <span key={artifact.id} className="rounded-md border border-border/60 px-2 py-1 font-data text-[10px] text-muted-foreground">
                          {artifact.kind}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-4">
                    <AgentChat
                      taskId={task.id}
                      initialMessages={task.messages.map((message) => ({
                        id: message.id,
                        role: message.role,
                        content: message.content,
                        createdAt: message.createdAt.toISOString(),
                      }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-data text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-words text-xs text-foreground/90">{value}</p>
    </div>
  );
}
