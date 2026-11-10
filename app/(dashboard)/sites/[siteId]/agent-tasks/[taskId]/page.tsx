import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";
import { PageHeader } from "@/components/ui/page-header";
import { WixTaskActions } from "@/components/work/wix-task-actions";

interface Props {
  params: Promise<{ siteId: string; taskId: string }>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const STATUS_TONE: Record<string, string> = {
  READY: "bg-muted text-muted-foreground",
  RUNNING: "bg-primary/10 text-primary",
  AWAITING_REVIEW: "bg-warning/15 text-warning",
  AWAITING_TARGET: "bg-warning/15 text-warning",
  CHANGES_REQUESTED: "bg-warning/15 text-warning",
  APPROVED: "bg-primary/10 text-primary",
  PUBLISHING: "bg-primary/10 text-primary",
  PUBLISHED: "bg-signal/10 text-signal",
  FAILED: "bg-danger/15 text-danger",
  CLOSED: "bg-muted text-muted-foreground",
};

export default async function AgentTaskPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const { siteId, taskId } = await params;
  if (!(await userOwnsAgentTask(taskId, userId))) notFound();

  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    include: {
      site: { select: { id: true, domain: true } },
      action: { select: { id: true, title: true, targetUrl: true, primaryQuery: true, status: true } },
      draft: { select: { id: true, title: true, metaTitle: true, metaDescription: true, excerpt: true, markdown: true } },
      artifacts: { where: { kind: "page_html" }, orderBy: { createdAt: "desc" }, take: 1 },
      messages: { orderBy: { createdAt: "asc" }, take: 40 },
    },
  });
  if (!task || task.site.id !== siteId) notFound();

  const result = record(task.result);
  const progress = record(result.progress);
  const awaitingTarget = record(result.awaitingTarget);
  const progressLines = Array.isArray(progress.lines)
    ? progress.lines.map((line) => record(line)).filter((line) => typeof line.message === "string")
    : [];
  const html = task.kind === "wix_page" ? task.artifacts[0]?.content ?? null : null;
  const route = task.route;
  const pageTitle = task.draft?.metaTitle || task.draft?.title || task.title;
  const pageDescription = task.draft?.metaDescription ?? "";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={task.site.domain}
        title={task.title}
        description={task.goal}
        actions={
          <div className="flex items-center gap-3">
            <span className={`rounded-md px-2 py-1 font-data text-[10px] uppercase ${STATUS_TONE[task.status] ?? "bg-muted text-muted-foreground"}`}>
              {task.status.replaceAll("_", " ")}
            </span>
            {task.action && (
              <Link href={`/sites/${siteId}/actions/${task.action.id}`} className="text-xs text-muted-foreground underline underline-offset-2">
                Source action
              </Link>
            )}
          </div>
        }
      />

      <section className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="font-data text-[10px] uppercase tracking-wide text-muted-foreground">
              {task.kind === "wix_article" ? "Wix Blog article" : "Wix page embed"}
              {route ? ` · ${route}` : ""}
            </p>
            {task.action?.primaryQuery && (
              <p className="text-sm text-muted-foreground">Target query: {task.action.primaryQuery}</p>
            )}
          </div>
          <WixTaskActions
            taskId={task.id}
            status={task.status}
            kind={task.kind}
            route={route}
            publishedUrl={task.publishedUrl}
          />
        </div>
        {task.status === "AWAITING_TARGET" && (
          <div className="mt-4 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
            <p className="font-medium text-warning">The Wix page does not exist yet</p>
            <p className="mt-1 text-muted-foreground">
              Create and publish a blank page at <code className="font-data text-foreground">{String(awaitingTarget.route ?? route ?? "")}</code> in
              the Wix editor. The agent creates the embed and delivers the content as soon as the page answers.
            </p>
            <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
              <p>Page title: <span className="text-foreground">{pageTitle}</span></p>
              {pageDescription && <p>Meta description: <span className="text-foreground">{pageDescription}</span></p>}
            </div>
          </div>
        )}
        {task.status === "FAILED" && task.errorCode && (
          <div className="mt-4 rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
            <p className="font-medium text-danger">Delivery stopped</p>
            <p className="mt-1 text-muted-foreground">{task.errorCode}</p>
          </div>
        )}
      </section>

      {html && (
        <section className="panel overflow-hidden">
          <div className="border-b border-border/60 p-4">
            <h2 className="font-heading text-base font-semibold">Page preview</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              The exact fragment delivered into the Wix page. Scripts are disabled here; styles and layout are the delivered ones.
            </p>
          </div>
          <iframe title="Delivered page preview" srcDoc={html} sandbox="" className="h-[680px] w-full bg-white" />
        </section>
      )}

      {task.kind === "wix_article" && task.draft && (
        <section className="panel p-5">
          <h2 className="font-heading text-base font-semibold">Article draft</h2>
          <p className="mt-1 text-sm text-muted-foreground">{task.draft.metaDescription}</p>
          <pre className="mt-3 max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-4 text-xs leading-6">
            {task.draft.markdown}
          </pre>
        </section>
      )}

      {progressLines.length > 0 && (
        <section className="panel p-5">
          <h2 className="font-heading text-base font-semibold">Agent progress</h2>
          <ul className="mt-2 space-y-1">
            {progressLines.slice(-20).map((line, index) => (
              <li key={index} className="font-data text-[11px] text-muted-foreground">
                {String(line.message)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.messages.length > 0 && (
        <section className="panel p-5">
          <h2 className="font-heading text-base font-semibold">Review notes</h2>
          <div className="mt-2 space-y-2">
            {task.messages.map((message) => (
              <div key={message.id} className="rounded-lg border border-border/50 p-3">
                <p className="font-data text-[9px] uppercase tracking-wide text-muted-foreground">{message.role}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{message.content}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
