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
      artifacts: {
        where: {
          OR: [
            { kind: { startsWith: "page_html" } },
            { kind: { in: ["design_notes", "navigation_notes", "navigation_edits"] } },
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
  const progress = record(result.progress);
  const awaitingTarget = record(result.awaitingTarget);
  const awaitingPlacement = record(result.awaitingPlacement);
  const delivery = record(result.delivery);
  const componentTag = typeof delivery.tag === "string" ? delivery.tag : null;
  const progressLines = Array.isArray(progress.lines)
    ? progress.lines.map((line) => record(line)).filter((line) => typeof line.message === "string")
    : [];
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

      <section className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="font-data text-[10px] uppercase tracking-wide text-muted-foreground">
              {task.kind === "wix_article"
                ? "Wix Blog article"
                : componentTag
                  ? `Wix page component · ${componentTag}`
                  : "Wix page embed"}
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
            hasPage={Boolean(html)}
          />
        </div>
        {task.status === "AWAITING_TARGET" && Object.keys(awaitingPlacement).length > 0 && (
          <div className="mt-4 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
            <p className="font-medium text-warning">The packet is deployed; the page has not rendered it yet</p>
            <p className="mt-1 text-muted-foreground">
              The early packets register and mount their elements themselves, so there is nothing to place in the editor.
              If a page is still blank, Wix is serving a cached document; check again shortly.
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
        )}
        {task.status === "AWAITING_TARGET" && Object.keys(awaitingPlacement).length === 0 && (
          <div className="mt-4 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
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
        )}
        {task.status === "FAILED" && task.errorCode && (
          <div className="mt-4 rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
            <p className="font-medium text-danger">Delivery stopped</p>
            <p className="mt-1 text-muted-foreground">{task.errorCode}</p>
          </div>
        )}
      </section>

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
