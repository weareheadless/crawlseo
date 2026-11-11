import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";
import { PageHeader } from "@/components/ui/page-header";
import { WixTaskActions } from "@/components/work/wix-task-actions";
import { AgentRunConsole } from "@/components/work/agent-run-console";
import { readAgentProgress } from "@/lib/agent-tasks/progress";
import { latestAgentRunJob } from "@/lib/agent-tasks/service";

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
      artifacts: {
        where: {
          OR: [
            { kind: { startsWith: "page_html" } },
            { kind: { in: ["preview_html", "design_notes", "navigation_notes", "navigation_edits"] } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 12,
      },
      messages: { orderBy: { createdAt: "asc" }, take: 40 },
    },
  });
  if (!task || task.site.id !== siteId) notFound();

  const route = task.route;
  const result = record(task.result);
  const awaitingTarget = record(result.awaitingTarget);
  const awaitingPlacement = record(result.awaitingPlacement);
  const delivery = record(result.delivery);
  const firstVariant = Array.isArray(delivery.variants) ? record(delivery.variants[0]) : {};
  const componentTag = typeof delivery.tag === "string"
    ? delivery.tag
    : typeof firstVariant.tag === "string"
      ? firstVariant.tag
      : null;
  const agentProgress = readAgentProgress(task.result);
  const codeSync = record(result.codeSync);
  const githubSha = typeof codeSync.commitSha === "string"
    ? codeSync.commitSha
    : typeof result.mergedSha === "string"
      ? result.mergedSha
      : null;
  const githubStatus = typeof codeSync.status === "string" ? codeSync.status : githubSha ? "pushed" : null;
  const githubReason = typeof codeSync.reason === "string" ? codeSync.reason : "";
  const githubFiles = Array.isArray(codeSync.files) ? codeSync.files.length : 0;
  const previewArtifact = task.artifacts.find((artifact) => artifact.kind === "preview_html") ?? null;
  const latestJob = await latestAgentRunJob(task.id);
  const pageArtifacts = task.kind === "wix_page"
    ? task.artifacts.filter((artifact) => artifact.kind === "page_html" || artifact.kind.startsWith("page_html:"))
    : [];
  const html = pageArtifacts.find((artifact) => artifact.kind === "page_html")?.content ?? pageArtifacts[0]?.content ?? null;
  const resultVariants = Array.isArray(result.variants)
    ? result.variants.map((variant) => record(variant)).filter((variant) => typeof variant.code === "string")
    : [];
  const pageVariants = resultVariants.length > 0
    ? resultVariants.map((variant) => {
        const code = String(variant.code);
        const artifact = pageArtifacts.find((item) => item.kind === (variant.isDefault === true ? "page_html" : `page_html:${code}`))
          ?? pageArtifacts.find((item) => item.kind === "page_html");
        return {
          code,
          route: typeof variant.route === "string" ? variant.route : route,
          url: typeof variant.url === "string" ? variant.url : null,
          isDefault: variant.isDefault === true,
          html: artifact?.content ?? null,
        };
      })
    : html
      ? [{ code: "default", route, url: null, isDefault: true, html }]
      : [];
  const designNotes = task.artifacts.find((artifact) => artifact.kind === "design_notes")?.content ?? null;
  const navigationNotes = task.artifacts.find((artifact) => artifact.kind === "navigation_notes")?.content ?? null;
  const navigationEditsRaw = task.artifacts.find((artifact) => artifact.kind === "navigation_edits")?.content ?? null;
  const navigationPlan = (() => {
    if (!navigationEditsRaw) return null;
    try {
      const parsed = JSON.parse(navigationEditsRaw) as { target?: string; component?: string; summary?: string; edits?: Array<{ find?: string; replace?: string }> };
      return parsed;
    } catch {
      return null;
    }
  })();
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

      {/* The actions stay reachable while the run and its preview scroll past:
          approving and running used to mean scrolling back to the top. */}
      <div className="sticky top-0 z-20 -mx-4 border-b border-border/60 bg-background px-4 py-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="truncate font-data text-[10px] uppercase tracking-wide text-muted-foreground">
              {task.kind === "wix_article"
                ? "Wix Blog article"
                : componentTag
                  ? `Wix page component · ${componentTag}`
                  : "Wix page embed"}
              {route ? ` · ${route}` : ""}
            </p>
            {task.action?.primaryQuery && (
              <p className="truncate text-[11px] text-muted-foreground">Query: {task.action.primaryQuery}</p>
            )}
          </div>
          <WixTaskActions
            taskId={task.id}
            status={task.status}
            kind={task.kind}
            route={route}
            publishedUrl={task.publishedUrl}
            hasPage={Boolean(html)}
          />
        </div>
      </div>

      {/* An article has no agent run: it publishes from its draft, so its
          conversation stays a plain list of review notes. */}
      {task.kind !== "wix_article" && (
        <AgentRunConsole
          taskId={task.id}
          initialStatus={task.status}
          initialProgress={agentProgress}
          initialMessages={task.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt.toISOString(),
          }))}
          initialJobStatus={latestJob?.status ?? null}
        />
      )}
      {task.kind === "wix_article" && task.messages.length > 0 && (
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
      {githubStatus && (
        <div
          className={`rounded-xl border px-4 py-2 font-data text-[11px] ${
            githubStatus === "pushed" || githubStatus === "nothing"
              ? "border-signal/30 bg-signal/5 text-signal"
              : "border-warning/40 bg-warning/5 text-warning"
          }`}
        >
          {githubStatus === "pushed" && (
            <>GitHub · main at {githubSha ? githubSha.slice(0, 7) : "unknown"}{githubFiles > 0 ? ` · ${githubFiles} file${githubFiles === 1 ? "" : "s"}` : ""}</>
          )}
          {githubStatus === "nothing" && <>GitHub · already up to date</>}
          {githubStatus === "skipped" && <>Not pushed to GitHub: {githubReason}</>}
          {githubStatus === "failed" && (
            <>GitHub push failed: {githubReason}. The page is live; the commit is local.</>
          )}
        </div>
      )}

      {task.status === "AWAITING_TARGET" && Object.keys(awaitingPlacement).length > 0 && (
        <section className="panel p-5">
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
            <p className="font-medium text-warning">Deployed; Wix has not rendered the element yet</p>
            <p className="mt-1 text-muted-foreground">
              The early packet in general custom code registers the element and the page&apos;s mount embed adds it, so there is nothing to place in the editor.
              If a page is still blank, Wix is serving a cached document; the worker checks again and publishes when it appears.
            </p>
            {Array.isArray(awaitingPlacement.variants) && (
              <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
                {awaitingPlacement.variants.map((variant) => {
                  const row = record(variant);
                  return (
                    <li key={String(row.route ?? row.tag)}>
                      <code className="font-data text-foreground">{String(row.tag ?? "")}</code> on {String(row.route ?? "")}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
              <p>Page title: <span className="text-foreground">{pageTitle}</span></p>
              {pageDescription && <p>Meta description: <span className="text-foreground">{pageDescription}</span></p>}
              <p>
                Narrow the packet&apos;s page scope in Wix Custom Code to this page so its bytes stop loading elsewhere.
              </p>
            </div>
          </div>
        </section>
      )}
      {task.status === "AWAITING_TARGET" && Object.keys(awaitingPlacement).length === 0 && (
        <section className="panel p-5">
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
            <p className="font-medium text-warning">The Wix page does not exist yet</p>
            <p className="mt-1 text-muted-foreground">
              Create and publish a blank page at{" "}
              {Array.isArray(awaitingTarget.variants) && awaitingTarget.variants.length > 0
                ? awaitingTarget.variants.map((variant, index) => {
                    const row = record(variant);
                    return (
                      <span key={String(row.route ?? index)}>
                        {index > 0 ? " and " : ""}
                        <code className="font-data text-foreground">{String(row.route ?? "")}</code>
                      </span>
                    );
                  })
                : <code className="font-data text-foreground">{String(awaitingTarget.route ?? route ?? "")}</code>}{" "}
              in the Wix editor. The agent delivers every locale as soon as the pages answer.
            </p>
            <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
              <p>Page title: <span className="text-foreground">{pageTitle}</span></p>
              {pageDescription && <p>Meta description: <span className="text-foreground">{pageDescription}</span></p>}
            </div>
          </div>
        </section>
      )}
      {task.status === "FAILED" && task.errorCode && (
        <section className="panel p-5">
          <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
            <p className="font-medium text-danger">Delivery stopped</p>
            <p className="mt-1 text-muted-foreground">{task.errorCode}</p>
          </div>
        </section>
      )}

      {previewArtifact?.content && (
        <section className="panel overflow-hidden">
          <div className="border-b border-border/60 p-4">
            <h2 className="font-heading text-base font-semibold">Preview</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              The changed page and component, rendered with the page&apos;s own copy. Live Wix data and page chrome are not loaded; every config variant (locale or market) is shown.
            </p>
          </div>
          {/* The URL carries the artifact time: a rerun writes a new preview and
              the iframe must reload instead of showing the previous run. */}
          <iframe
            title="Agent component preview"
            src={`/crawlseo/api/agent-tasks/${task.id}/preview?v=${previewArtifact.createdAt.getTime()}`}
            sandbox="allow-scripts"
            className="h-[680px] w-full bg-white"
          />
        </section>
      )}

      {pageVariants.map((variant) => variant.html && (
        <section key={variant.code} className="panel overflow-hidden">
          <div className="border-b border-border/60 p-4">
            <h2 className="font-heading text-base font-semibold">
              Page preview · {variant.code.toUpperCase()}
              {variant.isDefault ? " (default)" : ""}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {variant.route}
              {variant.url ? ` · ${variant.url}` : ""} — the exact fragment delivered into the Wix page. Scripts are disabled here; styles and layout are the delivered ones.
            </p>
          </div>
          <iframe title={`Delivered page preview ${variant.code}`} srcDoc={variant.html} sandbox="" className="h-[680px] w-full bg-white" />
        </section>
      ))}

      {designNotes && (
        <section className="panel p-5">
          <h2 className="font-heading text-base font-semibold">Design notes</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The tokens the agent used and where it found them. Save anything worth reusing in the site&apos;s design reference.
          </p>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-4 text-xs leading-6">
            {designNotes}
          </pre>
        </section>
      )}

      {navigationNotes && (
        <section className="panel p-5">
          <h2 className="font-heading text-base font-semibold">How visitors reach this page</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The agent chose the best link location from the site&apos;s own navigation, footer and related pages.
          </p>
          {navigationPlan && (
            <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 p-4">
              <p className="text-xs text-muted-foreground">
                Agent edit · <code className="font-data text-foreground">{String(navigationPlan.target ?? "")}</code>
                {navigationPlan.component ? ` · ${navigationPlan.component}` : ""}
              </p>
              {navigationPlan.summary && <p className="mt-1 text-sm text-foreground">{navigationPlan.summary}</p>}
              <p className="mt-2 text-xs text-muted-foreground">
                Approving writes this edit to the repository and rebuilds the component&apos;s early packet.
              </p>
            </div>
          )}
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-4 text-xs leading-6">
            {navigationNotes}
          </pre>
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

    </div>
  );
}
