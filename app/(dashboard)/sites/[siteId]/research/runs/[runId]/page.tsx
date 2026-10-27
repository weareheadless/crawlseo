import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { getResearchRun } from "@/lib/research/service";
import { jsonStringArray, sourceIdsForAction } from "@/lib/research/evidence";
import { SourceCitations, SourceList } from "@/components/research/source-evidence";

interface Props {
  params: Promise<{ siteId: string; runId: string }>;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function statusTone(status: string): string {
  if (status === "COMPLETED") return "bg-signal/10 text-signal";
  if (status === "PARTIAL") return "bg-warning/15 text-warning";
  if (status === "FAILED") return "bg-danger/15 text-danger";
  return "bg-primary/10 text-primary";
}

function actionStatusTone(status: string): string {
  if (status === "VERIFIED" || status === "FULFILLED" || status === "DELIVERED") return "bg-signal/10 text-signal";
  if (status === "FAILED" || status === "DISMISSED") return "bg-danger/15 text-danger";
  if (status === "PROPOSED" || status === "DRAFT_READY") return "bg-warning/15 text-warning";
  return "bg-primary/10 text-primary";
}

export default async function ResearchRunPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId, runId } = await params;
  if (!userId) redirect("/login");

  let run;
  try {
    run = await getResearchRun(runId, siteId);
  } catch {
    redirect(`/sites/${siteId}/research`);
  }

  const topics = stringList(run.topics);
  const providers = stringList(run.providerSet);
  const report = run.report && typeof run.report === "object" && !Array.isArray(run.report)
    ? run.report as Record<string, unknown>
    : null;
  const sourceErrors = stringList(report?.source_errors);
  const automation = report?.automation && typeof report.automation === "object" && !Array.isArray(report.automation)
    ? report.automation as Record<string, unknown>
    : null;
  const automationDrafts = objectArray(automation?.drafts);
  const automationTasks = objectArray(automation?.agentTasks);
  const automationSkipped = objectArray(automation?.skipped);

  return (
    <div>
      <PageHeader
        eyebrow={run.site.domain}
        title={run.title}
        description={`Research run · ${run.createdAt.toLocaleString()}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DataLagBadge />
            <Link href={`/sites/${siteId}/research`} className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground">
              Back to Research
            </Link>
            <Link href={`/sites/${siteId}/work`} className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground">
              Work queue
            </Link>
          </div>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Status" value={run.status.toLowerCase()} tone={statusTone(run.status)} />
        <Fact label="Sources" value={String(run.sources.length)} />
        <Fact label="Findings" value={String(run.findings.length)} />
        <Fact label="Actions" value={String(run.actions.length)} />
      </div>

      <section className="panel mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-lg font-semibold">What the AI investigated</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These are the configured topics and providers used for this run. The source list below is the evidence the model received.
            </p>
          </div>
          {run.errorCode && (
            <span className="rounded-md bg-warning/15 px-2 py-1 font-data text-[10px] uppercase text-warning">
              {run.errorCode.replaceAll("_", " ").toLowerCase()}
            </span>
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Topics" value={topics.join(", ") || "Not stored"} />
          <Fact label="Providers" value={providers.join(", ") || "Not stored"} />
          <Fact label="Recency" value={`${run.recencyDays} days`} />
          <Fact label="Model" value={run.model || (typeof report?.synthesis === "object" && report.synthesis && "model" in report.synthesis ? String((report.synthesis as Record<string, unknown>).model ?? "Not stored") : "Not stored")} />
        </div>
        {sourceErrors.length > 0 && (
          <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3">
            <p className="font-data text-[10px] uppercase text-warning">Source collection warnings</p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {sourceErrors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          </div>
        )}
      </section>

      <div className="space-y-5">
        <SourceList
          sources={run.sources}
          title="Collected sources"
          description="Open the original link to validate each source. The excerpt is the stored text the research model received, not a paraphrase."
        />

        <section className="panel overflow-hidden">
          <div className="border-b border-border/60 p-5">
            <h2 className="font-heading text-lg font-semibold">Findings and citations</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every finding must point to at least one collected source. Follow the citations before acting on it.
            </p>
          </div>
          {run.findings.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">No findings were saved for this run.</p>
          ) : (
            <div className="divide-y divide-border/40">
              {run.findings.map((finding) => {
                const citedIds = jsonStringArray(finding.evidenceSourceIds);
                return (
                  <article key={finding.id} className="p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-muted px-1.5 py-0.5 font-data text-[10px] uppercase text-muted-foreground">
                        {finding.type.toLowerCase()}
                      </span>
                      <span className="font-data text-[10px] text-muted-foreground">confidence {finding.confidence}</span>
                      {finding.sentiment && <span className="font-data text-[10px] text-muted-foreground">{finding.sentiment}</span>}
                      {finding.urgency && <span className="font-data text-[10px] text-warning">{finding.urgency} urgency</span>}
                    </div>
                    <h3 className="mt-2 text-sm font-semibold">{finding.theme}</h3>
                    <p className="mt-1 text-sm leading-6 text-foreground/85">{finding.summary}</p>
                    <div className="mt-3">
                      <p className="mb-1.5 font-data text-[10px] uppercase tracking-wide text-muted-foreground">
                        Cited sources
                      </p>
                      <SourceCitations sources={run.sources} sourceIds={citedIds} />
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel overflow-hidden">
          <div className="border-b border-border/60 p-5">
            <h2 className="font-heading text-lg font-semibold">Actions from this run</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each action links back to the Work item and the sources that justify it.
            </p>
          </div>
          {run.actions.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">No actions were created from this run.</p>
          ) : (
            <div className="divide-y divide-border/40">
              {run.actions.map((action) => {
                const citedIds = sourceIdsForAction(action);
                return (
                  <article key={action.id} className="p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/sites/${siteId}/actions/${action.id}`} className="text-sm font-semibold underline decoration-border underline-offset-2 hover:text-primary">
                        {action.title}
                      </Link>
                      <span className={`rounded-md px-1.5 py-0.5 font-data text-[10px] uppercase ${actionStatusTone(action.status)}`}>
                        {action.status.toLowerCase().replaceAll("_", " ")}
                      </span>
                      <span className="font-data text-[10px] text-muted-foreground">priority {action.priority}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{action.recommendation}</p>
                    <div className="mt-3">
                      <p className="mb-1.5 font-data text-[10px] uppercase tracking-wide text-muted-foreground">Evidence</p>
                      <SourceCitations sources={run.sources} sourceIds={citedIds} emptyText="No linked source IDs for this action." />
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {automation && (
          <section className="panel overflow-hidden">
            <div className="border-b border-border/60 p-5">
              <h2 className="font-heading text-lg font-semibold">Automation</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Results of the site&apos;s auto-draft and auto-agent policies. Agent tasks are created for review; they are not run automatically.
              </p>
            </div>
            <div className="grid gap-3 border-b border-border/40 p-5 sm:grid-cols-3">
              <Fact label="Drafts created" value={String(automationDrafts.filter((item) => item.status === "created").length)} />
              <Fact label="Agent tasks created" value={String(automationTasks.filter((item) => item.status === "created").length)} />
              <Fact label="Skipped" value={String(automationSkipped.length)} />
            </div>
            <div className="divide-y divide-border/40">
              {automationDrafts.map((item, index) => (
                <AutomationRow key={`draft-${item.actionId ?? index}`} item={item} kind="draft" actions={run.actions} siteId={siteId} />
              ))}
              {automationTasks.map((item, index) => (
                <AutomationRow key={`task-${item.actionId ?? index}`} item={item} kind="agent task" actions={run.actions} siteId={siteId} />
              ))}
              {automationSkipped.map((item, index) => (
                <AutomationRow key={`skip-${item.actionId ?? index}`} item={item} kind="skipped" actions={run.actions} siteId={siteId} />
              ))}
              {automationDrafts.length === 0 && automationTasks.length === 0 && automationSkipped.length === 0 && (
                <p className="px-5 py-6 text-sm text-muted-foreground">No actions were eligible for automation.</p>
              )}
            </div>
          </section>
        )}

        {report && (
          <details className="panel p-5">
            <summary className="cursor-pointer font-data text-[10px] uppercase tracking-wide text-muted-foreground">Raw run report</summary>
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-[10px] leading-5">
              {JSON.stringify(report, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function AutomationRow({
  item,
  kind,
  actions,
  siteId,
}: {
  item: Record<string, unknown>;
  kind: "draft" | "agent task" | "skipped";
  actions: Array<{ id: string; title: string }>;
  siteId: string;
}) {
  const actionId = typeof item.actionId === "string" ? item.actionId : null;
  const action = actionId ? actions.find((candidate) => candidate.id === actionId) : null;
  const status = typeof item.status === "string" ? item.status : kind === "skipped" ? "skipped" : "unknown";
  const reason = typeof item.reason === "string" ? item.reason.replaceAll("_", " ") : null;
  const error = typeof item.error === "string" ? item.error : null;

  return (
    <div className="flex flex-wrap items-start justify-between gap-2 px-5 py-3 text-sm">
      <div>
        <p className="font-medium">
          {action ? (
            <Link href={`/sites/${siteId}/actions/${action.id}`} className="underline decoration-border underline-offset-2 hover:text-primary">
              {action.title}
            </Link>
          ) : actionId ?? "Unknown action"}
        </p>
        <p className="mt-0.5 font-data text-[10px] uppercase text-muted-foreground">
          {kind} · {status}{reason ? ` · ${reason}` : ""}
        </p>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <span className={`rounded-md px-1.5 py-0.5 font-data text-[10px] uppercase ${status === "created" ? "bg-signal/10 text-signal" : status === "failed" ? "bg-danger/15 text-danger" : "bg-muted text-muted-foreground"}`}>
        {status}
      </span>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`panel p-4 ${tone ?? ""}`}>
      <p className="font-data text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-medium text-foreground/90">{value}</p>
    </div>
  );
}
