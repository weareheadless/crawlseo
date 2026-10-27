import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { getActionDetail } from "@/lib/work/service";
import { db } from "@/lib/db";
import { ActionControls } from "@/components/work/action-controls";
import { AgentChat } from "@/components/work/agent-chat";
import { WixBlogDraftButton } from "@/components/work/wix-blog-draft-button";
import { AgentTaskPrimary } from "@/components/work/agent-task-primary";
import { AgentTaskProgress } from "@/components/work/agent-task-progress";
import { AgentTaskBridgePlanButton } from "@/components/work/agent-task-bridge-plan-button";
import { WixBlogUpdateControls } from "@/components/work/wix-blog-update-controls";
import { EmbedDeliveryControls } from "@/components/work/embed-delivery-controls";
import { SourceList } from "@/components/research/source-evidence";
import { keywordEvidenceForAction } from "@/lib/research/evidence";
import { opportunityPriorityForAction, opportunitySignalLabel } from "@/lib/ai-seo/opportunity-priority";
import { actionDimension } from "@/lib/work/categories";
import { isTechnicalSeoAction, isWixBlogTarget } from "@/lib/agent-tasks/targets";
import { selectEmbedTargetKey } from "@/lib/delivery/target-selection";
import { cn } from "@/lib/utils";
import { isReleaseableSiteFile, parseGitStatusFiles } from "@/lib/agent-tasks/changes";
import { getSiteExecutionAuthority } from "@/lib/research/execution-authority";
import { ExternalExecutionNotice } from "@/components/work/external-execution-notice";

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
  const citedSources = action.evidenceSources;
  const editorial = editorialFromEvidence(action.evidence);
  const crawlEvidence = crawlEvidenceFrom(action.evidence);
  const technicalAction = isTechnicalSeoAction(action);
  const blogTarget = !technicalAction && isWixBlogTarget(action.targetUrl);
  const blogDraft = blogTarget
    ? action.drafts.find((candidate) => candidate.format === "article" && candidate.status !== "ARCHIVED") ?? null
    : null;
  const blogPublished = action.deliveries.find(
    (delivery) => delivery.platform === "wix_blog" && delivery.status === "PUBLISHED",
  ) ?? null;
  const keywordEvidence = keywordEvidenceForAction(action.evidence);
  const opportunityPriority = opportunityPriorityForAction(action);
  const deliveryTargets = await db.deliveryTarget.findMany({
    where: { siteId, enabled: true, adapter: "wix_embed" },
    orderBy: { key: "asc" },
    select: { key: true, componentTag: true, snippetId: true, sourcePath: true },
  });

  const preferredEmbedTargetKey = selectEmbedTargetKey(deliveryTargets, {
    title: action.title,
    targetUrl: action.targetUrl,
  }) ?? undefined;
  const preferredTarget = deliveryTargets.find((target) => target.key === preferredEmbedTargetKey);
  const authority = await getSiteExecutionAuthority(siteId);
  const externallyManaged = authority?.managed ?? false;
  const coverage = action.questionCoverages[0] ?? null;
  const knowledgeRevision = coverage?.documentId && coverage.evidenceRevision != null
    ? await db.businessKnowledgeRevision.findUnique({
        where: { documentId_revision: { documentId: coverage.documentId, revision: coverage.evidenceRevision } },
        select: { revision: true, fields: true },
      })
    : null;

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

      <section className="panel mb-5 p-5" aria-label="Action provenance">
        <h2 className="font-heading text-lg font-semibold">Why this Action exists</h2>
        <p className="mt-1 text-xs text-muted-foreground">{actionDimension(action).toUpperCase()} · provenance from recorded research and coverage.</p>
        <ol className="mt-4 space-y-3 border-l border-border pl-4 text-sm">
          <li>
            <strong>Knowledge revision and field:</strong>{" "}
            {coverage?.document && coverage.evidenceRevision != null && coverage.fieldPath ? (
              <Link className="text-primary underline" href={`/sites/${siteId}/intelligence`}>Knowledge {coverage.document.logicalId}, revision {coverage.evidenceRevision}, field {coverage.fieldPath}{knowledgeRevision ? ` (${Object.prototype.hasOwnProperty.call(record(knowledgeRevision.fields), coverage.fieldPath) ? "field recorded" : "field missing from revision"})` : " (revision missing)"}</Link>
            ) : <span className="text-muted-foreground">Missing hop: no knowledge revision/field is linked to this Action.</span>}
          </li>
          <li><strong>Research finding:</strong>{" "}{action.finding ? <Link className="text-primary underline" href={`/sites/${siteId}/research/runs/${action.runId ?? action.finding.runId}`}>{action.finding.summary}</Link> : <span className="text-muted-foreground">Missing hop: no research finding is linked.</span>}</li>
          <li><strong>Sources and retrieval dates:</strong>{" "}{action.evidenceSources.length ? <ul className="mt-1 list-disc pl-5">{action.evidenceSources.map((source) => <li key={source.id}><a className="text-primary underline" href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a> · retrieved {source.retrievedAt.toISOString().slice(0, 10)}</li>)}</ul> : <span className="text-muted-foreground">Missing hop: no source is linked to the finding or Action.</span>}</li>
          <li><strong>Question coverage:</strong>{" "}{coverage ? <Link className="text-primary underline" href={`/sites/${siteId}/intelligence`}>{coverage.status.toLowerCase()} · {coverage.service} / {coverage.audience} · {coverage.missingEvidence ?? "no missing-evidence note"}</Link> : <span className="text-muted-foreground">Missing hop: no coverage record is linked to this Action.</span>}</li>
          <li><strong>Action:</strong> {action.title} · {action.status.toLowerCase().replaceAll("_", " ")}</li>
          <li><strong>Outcome:</strong>{" "}{action.deliveries.length ? action.deliveries.map((delivery) => `${delivery.status.toLowerCase()} (${delivery.createdAt.toISOString().slice(0, 10)})`).join("; ") : ["VERIFIED", "FULFILLED", "FAILED", "DISMISSED"].includes(action.status) ? action.status.toLowerCase() : "Missing hop: no outcome is recorded yet."}</li>
        </ol>
      </section>

      {editorial && (
        <section className="panel mb-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-lg font-semibold">Editorial decision</h2>
            <span className="rounded-md bg-primary/10 px-2 py-1 font-data text-[10px] font-semibold uppercase text-primary">
              {String(editorial.decision).replaceAll("_", " ")}
            </span>
            <span className="font-data text-[10px] text-muted-foreground">
              page fit {String(editorial.pageFit ?? "unknown")} · confidence {String(editorial.confidence ?? "—")}
            </span>
          </div>
          <p className="mt-3 text-sm font-medium">{String(editorial.title ?? "")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{String(editorial.scope ?? "")}</p>
          <p className="mt-2 text-xs text-muted-foreground">{String(editorial.rationale ?? "")}</p>
          {Array.isArray(editorial.mustPreserve) && editorial.mustPreserve.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Preserve: {editorial.mustPreserve.filter((item): item is string => typeof item === "string").join(", ")}
            </p>
          )}
        </section>
      )}

      <div className="mb-5">
        <SourceList
          sources={citedSources}
          title="Evidence sources"
          description="Verify these original sources before approving the action or the generated content. The excerpt is the text stored when the source was retrieved."
          emptyText={action.source === "seo_opportunity"
            ? "This action is based on Search Console and crawl evidence in the structured evidence panel below, not an external article."
            : action.source === "crawl_issue"
              ? "This action is based on crawl evidence in the structured evidence panel below, not an external article."
              : action.source === "keyword_research"
                ? "This action is based on keyword demand evidence in the structured evidence panel below, not an external article."
                : "No source links were stored for this action. Treat it as unverified until evidence is attached."}
        />
      </div>

      {keywordEvidence && (
        <section className="panel mb-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-heading text-lg font-semibold">Keyword research evidence</h2>
                <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-data text-[10px] uppercase text-primary">
                  keyword research
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                This keyword demand was attached to the Work item as supporting evidence. It explains the query demand behind the update.
              </p>
            </div>
            <Link href={`/sites/${siteId}/keyword-research`} className="text-xs text-primary underline underline-offset-2">
              Open Keyword Research
            </Link>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Fact label="Keyword" value={keywordEvidence.keyword} />
            <Fact label="Volume" value={keywordEvidence.volume != null ? `${keywordEvidence.volume.toLocaleString()}/mo` : "—"} />
            <Fact label="Difficulty" value={keywordEvidence.difficulty != null ? String(keywordEvidence.difficulty) : "—"} />
            <Fact label="CPC" value={keywordEvidence.cpc != null ? `$${keywordEvidence.cpc.toFixed(2)}` : "—"} />
            <Fact label="Competition" value={keywordEvidence.competition != null ? String(keywordEvidence.competition) : "—"} />
            <Fact label="Intent" value={keywordEvidence.intent || "—"} />
          </div>
          {keywordEvidence.queuedAt && (
            <p className="mt-3 font-data text-[10px] text-muted-foreground">
              Queued {new Date(keywordEvidence.queuedAt).toLocaleString()}
            </p>
          )}
        </section>
      )}

      {opportunityPriority && (
        <section className="panel mb-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-lg font-semibold">Why this priority</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                The Work priority is the strongest attached signal. The SEO opportunity score is computed from measured GSC impact, confidence, and effort.
              </p>
            </div>
            <span className="rounded-md bg-primary/10 px-2 py-1 font-data text-[10px] font-semibold text-primary">
              priority {action.priority}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {opportunityPriority.signals.map((signal) => (
              <span key={signal} className="rounded-md border border-border/60 bg-background px-2 py-0.5 font-data text-[10px] text-muted-foreground">
                {opportunitySignalLabel(signal)}
              </span>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Fact label="Work priority" value={String(action.priority)} />
            <Fact label="SEO score" value={String(opportunityPriority.seoScore)} />
            <Fact label="Impact" value={String(opportunityPriority.impact)} />
            <Fact label="Confidence" value={`${opportunityPriority.confidence}%`} />
            <Fact label="Effort" value={String(opportunityPriority.effort)} />
            <Fact label="Expected clicks" value={opportunityPriority.expectedClicks != null ? `+${opportunityPriority.expectedClicks.toLocaleString()}` : "—"} />
          </div>
          {opportunityPriority.keywordScore != null && (
            <p className="mt-3 text-xs text-muted-foreground">
              Keyword research score: <span className="font-semibold text-foreground">{opportunityPriority.keywordScore}</span>
              {opportunityPriority.keyword?.keyword ? ` for “${opportunityPriority.keyword.keyword}”` : ""}.
            </p>
          )}
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
            SEO score = impact 55% + confidence 25% + effort 20%. The final Work priority can be higher when keyword demand or market research is attached.
          </p>
        </section>
      )}

      <div className="mb-5">
        {externallyManaged ? (
          <ExternalExecutionNotice executor={authority?.executor ?? null} reviewOrigin={authority?.reviewOrigin ?? null} />
        ) : (
          <ActionControls
            actionId={action.id}
            initialStatus={action.status}
            hasDraft={action.drafts.length > 0}
            blogTarget={blogTarget}
          />
        )}
      </div>

      {crawlEvidence && (
        <section className="panel mb-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-lg font-semibold">Crawl verification</h2>
            <span className={cn(
              "rounded-md px-2 py-1 font-data text-[10px] font-semibold uppercase",
              crawlEvidence.reproduced === false && "bg-signal/10 text-signal",
              crawlEvidence.reproduced === true && "bg-warning/15 text-warning",
              crawlEvidence.reproduced == null && "bg-muted text-muted-foreground",
            )}>
              {crawlEvidence.reproduced === false
                ? "not reproduced live"
                : crawlEvidence.reproduced === true
                  ? "reproduced live"
                  : "live check unavailable"}
            </span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Crawl date" value={crawlEvidence.crawlDate ?? "unknown"} />
            <Fact label="Issue" value={crawlEvidence.issueType?.replaceAll("_", " ").toLowerCase() ?? "—"} />
            <Fact label="Affected pages" value={crawlEvidence.affectedPages != null ? String(crawlEvidence.affectedPages) : "—"} />
            <Fact label="Target H1 count" value={crawlEvidence.h1Count != null ? String(crawlEvidence.h1Count) : "—"} />
          </div>
          <p className="mt-3 break-all font-data text-[10px] text-muted-foreground">
            Target: {action.targetUrl ?? "—"}
          </p>
          {crawlEvidence.families.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Templates: {crawlEvidence.families.join(", ")}
            </p>
          )}
          {crawlEvidence.duplicateValue && (
            <p className="mt-2 text-xs text-muted-foreground">
              Duplicate value: <span className="font-medium text-foreground">{crawlEvidence.duplicateValue}</span>
            </p>
          )}
          {crawlEvidence.examples.length > 0 && (
            <div className="mt-2 rounded border border-border/50 bg-background/50 p-2">
              <p className="font-data text-[10px] uppercase text-muted-foreground">Examples</p>
              <ul className="mt-1 space-y-1">
                {crawlEvidence.examples.map((example) => (
                  <li key={example.url} className="text-[10px] leading-4 text-muted-foreground">
                    <span className="font-data">{example.statusCode ?? "—"}</span>
                    {" · "}
                    <span className="break-all">{example.url}</span>
                    {example.title && <span className="block pl-8 text-foreground/80">Title: {example.title}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {crawlEvidence.urls.length > 1 && (
            <details className="mt-2 rounded border border-border/50 bg-background/50 p-2">
              <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">
                Affected pages ({crawlEvidence.affectedPages ?? crawlEvidence.urls.length})
              </summary>
              <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto font-data text-[10px] text-muted-foreground">
                {crawlEvidence.urls.slice(0, 30).map((url) => (
                  <li key={url} className="truncate" title={url}>{url}</li>
                ))}
              </ul>
            </details>
          )}
          {crawlEvidence.reason && (
            <p className="mt-1 text-xs text-muted-foreground">{crawlEvidence.reason}</p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            The crawl is a snapshot. A live check is run for page-level issues before the action is kept; a mismatch means the issue may already be fixed or the crawl may have received a different page.
          </p>
        </section>
      )}

      <div className={blogTarget ? "grid gap-5" : "grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"}>
        <div className="space-y-5">
          <section className="panel p-5">
            <h2 className="font-heading text-lg font-semibold">Evidence and recommendation</h2>
            {action.run && (
              <p className="mt-3 text-xs text-muted-foreground">
                Research run:{" "}
                <Link href={`/sites/${siteId}/research/runs/${action.run.id}`} className="text-primary underline underline-offset-2">
                  {action.run.title}
                </Link>
              </p>
            )}
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
            <EvidenceSummary evidence={action.evidence} targetUrl={action.targetUrl} />
            <details className="mt-4">
              <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">Raw evidence</summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-[10px] leading-5">
                {json(action.evidence)}
              </pre>
            </details>
          </section>

          {blogTarget && (
            <section className="panel p-5">
              <h2 className="font-heading text-lg font-semibold">Wix Blog update</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                This action updates an existing Wix Blog post, not a custom element. The agent task is intentionally skipped.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-data uppercase tracking-wide text-muted-foreground">Existing post</span>
                {action.targetUrl && (
                  <a href={action.targetUrl} target="_blank" rel="noreferrer noopener" className="break-all text-primary underline underline-offset-2">
                    {action.targetUrl}
                  </a>
                )}
              </div>
              {externallyManaged ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  This Wix Blog update is approved and published in {authority?.executor === "helloada" ? "HelloAda" : "the connected review workspace"}.
                </p>
              ) : (
                <WixBlogUpdateControls
                  actionId={action.id}
                  draftId={blogDraft?.id}
            approved={Boolean(blogDraft?.wixApprovalHash && blogDraft.wixApprovedBy === userId && blogDraft.wixApprovedRevision === action.revision)}
                  publishedUrl={blogPublished ? action.targetUrl : null}
                  status={action.status}
                />
              )}
            </section>
          )}

          <section className="panel p-5">
            <h2 className="font-heading text-lg font-semibold">{blogTarget ? "Blog update content" : "Content drafts"}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Drafts are generated from the evidence sources above. Verify those links before publishing.
            </p>
            {action.drafts.filter((draft) => draft.status !== "ARCHIVED").length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No content draft yet.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {action.drafts.filter((draft) => draft.status !== "ARCHIVED").map((draft) => (
                  <details key={draft.id} open={blogTarget && draft.id === blogDraft?.id} className="rounded-lg border border-border/60 p-3">
                    <summary className="cursor-pointer list-none">
                      <span className="text-sm font-medium">{draft.title}</span>
                      <span className="ml-2 font-data text-[10px] text-muted-foreground">{draft.format} · {draft.createdAt.toLocaleString()}</span>
                    </summary>
                    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-5 text-foreground/80">
                      {draft.markdown}
                    </pre>
                    {!blogTarget && draft.format === "article" && !externallyManaged && (
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

        {!blogTarget && (
        <section className="panel overflow-hidden">
            <div className="border-b border-border/60 p-5">
              <h2 className="font-heading text-lg font-semibold">Implementation</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {externallyManaged
                  ? "Implementation is owned by the connected review workspace. This section is a read-only record."
                  : "Review the change, approve it, and update the site."}
              </p>
            </div>
            {action.agentTasks.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">No agent task yet.</p>
            ) : (
              <div className="divide-y divide-border/40">
                {action.agentTasks.map((task) => (
                  <div key={task.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-semibold">{task.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{task.goal}</p>
                      </div>
                      {externallyManaged ? (
                        <span className="rounded-md border border-border/60 bg-muted/20 px-2 py-1 font-data text-[10px] uppercase text-muted-foreground">
                          {task.status.toLowerCase().replaceAll("_", " ")}
                        </span>
                      ) : (
                        <div className="flex flex-col items-end gap-1">
                          <AgentTaskPrimary
                            taskId={task.id}
                            status={task.status}
                            hasEmbedTarget={deliveryTargets.length > 0}
                            requiresSiteRelease={hasSiteCodeChanges(task, preferredTarget?.sourcePath ?? null)}
                            hasReleaseableChange={hasSiteCodeChanges(task, preferredTarget?.sourcePath ?? null)}
                            targetComponentTag={preferredTarget?.componentTag ?? null}
                            publishedUrl={task.publishedUrl}
                          />
                          {task.artifacts.some((artifact) => artifact.kind === "preview_html") && (
                            <a
                              href={`/crawlseo/api/agent-tasks/${task.id}/preview`}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-xs text-primary underline underline-offset-2"
                            >
                              Preview change
                            </a>
                          )}
                        </div>
                      )}
                    </div>

                    <AgentTaskProgress
                      taskId={task.id}
                      status={task.status}
                      startedAt={task.startedAt?.toISOString() ?? null}
                      result={task.result}
                      errorCode={task.errorCode}
                    />

                    <TaskChange task={task} result={task.result} errorCode={task.errorCode} />

                    <div className="mt-4">
                      <p className="mb-2 font-data text-[10px] uppercase tracking-wide text-muted-foreground">Corrections</p>
                      {externallyManaged ? (
                        <p className="text-xs text-muted-foreground">
                          Corrections are requested from the owner review surface in {authority?.executor === "helloada" ? "HelloAda" : "the connected review workspace"}.
                        </p>
                      ) : (
                      <AgentChat
                        taskId={task.id}
                        initialMessages={task.messages.map((message) => ({
                          id: message.id,
                          role: message.role,
                          content: message.content,
                          createdAt: message.createdAt.toISOString(),
                        }))}
                      />
                      )}
                      {!externallyManaged && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Sending a message reopens a closed task for a follow-up run.
                        </p>
                      )}
                    </div>

                    <details className="mt-4 rounded-lg border border-border/60 bg-muted/10 p-3">
                      <summary className="cursor-pointer font-data text-[10px] uppercase tracking-wide text-muted-foreground">Advanced</summary>
                      <div className="mt-3 space-y-3">
                        <p className="font-data text-[10px] text-muted-foreground">
                          {task.repoPath}{task.branch ? ` · ${task.branch}` : ""}{task.route ? ` · ${task.route}` : ""}
                        </p>
                        <details>
                          <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">Prompt</summary>
                          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-[10px] leading-5">
                            {task.prompt}
                          </pre>
                        </details>
                        {task.artifacts.length > 0 && (
                          <div className="space-y-2">
                            {task.artifacts.map((artifact) => (
                              <details key={artifact.id} className="rounded-lg border border-border/60 bg-background p-3">
                                <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">
                                  {artifact.kind.replaceAll("_", " ")}
                                  {artifact.content ? ` · ${artifact.content.length.toLocaleString()} chars` : ""}
                                </summary>
                                {artifact.url && (
                                  <a href={artifact.url} target="_blank" rel="noreferrer noopener" className="mt-2 block break-all text-xs text-primary underline underline-offset-2">
                                    {artifact.url}
                                  </a>
                                )}
                                {artifact.content && (
                                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-[10px] leading-5">
                                    {artifact.content.slice(0, 40_000)}
                                    {artifact.content.length > 40_000 ? "\n\n[artifact truncated in view]" : ""}
                                  </pre>
                                )}
                              </details>
                            ))}
                          </div>
                        )}
                        {!externallyManaged && (
                          <>
                            <div className="flex flex-wrap gap-2">
                              <AgentTaskBridgePlanButton taskId={task.id} disabled={!task.worktreePath} />
                            </div>
                            <EmbedDeliveryControls
                              taskId={task.id}
                              status={task.status}
                              hasWorktree={Boolean(task.worktreePath)}
                              targets={deliveryTargets}
                              initialTargetKey={preferredEmbedTargetKey}
                            />
                          </>
                        )}
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function TaskChange({
  task,
  result,
  errorCode,
}: {
  task: {
    goal: string;
    artifacts: Array<{ kind: string; content: string | null }>;
  };
  result: unknown;
  errorCode: string | null;
}) {
  const gitStatus = task.artifacts.find((artifact) => artifact.kind === "git_status")?.content ?? "";
  const diff = task.artifacts.find((artifact) => artifact.kind === "diff")?.content ?? "";
  const agentOutput = task.artifacts.find((artifact) => artifact.kind === "agent_output")?.content ?? "";
  const resultState = result && typeof result === "object" && !Array.isArray(result)
    ? result as { outcome?: unknown; files?: unknown; summary?: unknown }
    : {};
  const resultFiles = Array.isArray(resultState.files)
    ? resultState.files.filter((file): file is string => typeof file === "string")
    : [];
  const files = resultFiles.length > 0 ? resultFiles : parseGitStatusFiles(gitStatus);
  const outcome = typeof resultState.outcome === "string" ? resultState.outcome : null;
  const outcomeLabel = outcome === "changes_ready"
    ? "Reviewable site-code changes — not committed or pushed."
    : outcome === "non_code_changes"
      ? "Non-code changes only — not releaseable through the site-code pipeline."
      : outcome === "no_changes"
        ? "No files changed."
        : errorCode
          ? `Task stopped with ${errorCode}.`
          : null;

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/10 p-3">
      <p className="font-data text-[10px] uppercase tracking-wide text-muted-foreground">Change</p>
      <p className="mt-1 text-sm leading-6 text-foreground/90">{task.goal}</p>
      {outcomeLabel && <p className="mt-1 text-[11px] font-medium text-muted-foreground">{outcomeLabel}</p>}
      {files.length > 0 && (
        <p className="mt-2 break-all font-data text-[10px] text-muted-foreground">
          Files: {files.join(", ")}
        </p>
      )}
      {agentOutput && (
        <details className="mt-2">
          <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">Agent notes</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-background p-3 text-[10px] leading-5">
            {agentOutput.slice(0, 12_000)}
          </pre>
        </details>
      )}
      {diff && (
        <details className="mt-2">
          <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">View diff</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-background p-3 text-[10px] leading-5">
            {diff.slice(0, 40_000)}
            {diff.length > 40_000 ? "\n\n[diff truncated in view]" : ""}
          </pre>
        </details>
      )}
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

function hasSiteCodeChanges(
  task: { artifacts: Array<{ kind: string; content: string | null }>; result?: unknown },
  targetSourcePath: string | null,
): boolean {
  const status = task.artifacts
    .find((artifact) => artifact.kind === "git_status" && artifact.content)?.content ?? "";
  const result = task.result && typeof task.result === "object" && !Array.isArray(task.result)
    ? task.result as { files?: unknown }
    : {};
  const resultFiles = Array.isArray(result.files)
    ? result.files.filter((file): file is string => typeof file === "string")
    : [];
  const files = resultFiles.length > 0 ? resultFiles : parseGitStatusFiles(status);
  return files.some((file) => file === targetSourcePath || isReleaseableSiteFile(file));
}

function crawlEvidenceFrom(evidence: unknown): {
  crawlDate: string | null;
  issueType: string | null;
  affectedPages: number | null;
  h1Count: number | null;
  reproduced: boolean | null;
  reason: string | null;
  families: string[];
  urls: string[];
  duplicateValue: string | null;
  examples: Array<{ url: string; title: string | null; statusCode: number | null }>;
} | null {
  const root = record(evidence);
  if (root.kind !== "crawl_issue") return null;
  const live = record(root.live_check);
  const page = record(root.page);
  return {
    crawlDate: typeof root.crawl_finished_at === "string" ? root.crawl_finished_at.slice(0, 10) : null,
    issueType: typeof root.issue_type === "string" ? root.issue_type : null,
    affectedPages: typeof root.affected_pages === "number" ? root.affected_pages : null,
    h1Count: typeof live.h1_count === "number"
      ? live.h1_count
      : typeof page.h1Count === "number" ? page.h1Count : null,
    reproduced: typeof live.issue_reproduced === "boolean" ? live.issue_reproduced : null,
    reason: typeof live.reason === "string" ? live.reason : null,
    families: Array.isArray(root.route_families)
      ? root.route_families.filter((value): value is string => typeof value === "string")
      : [],
    urls: Array.isArray(root.urls)
      ? root.urls.filter((value): value is string => typeof value === "string")
      : [],
    duplicateValue: typeof root.duplicate_value === "string" ? root.duplicate_value : null,
    examples: Array.isArray(root.examples)
      ? root.examples
        .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
        .map((value) => ({
          url: typeof value.url === "string" ? value.url : "",
          title: typeof value.title === "string" ? value.title : null,
          statusCode: typeof value.statusCode === "number" ? value.statusCode : null,
        }))
        .filter((value) => value.url)
        .slice(0, 5)
      : [],
  };
}

function editorialFromEvidence(evidence: unknown): Record<string, unknown> | null {
  const editorial = record(record(evidence).editorial);
  return Object.keys(editorial).length > 0 ? editorial : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function displayValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  return null;
}

function EvidenceSummary({ evidence, targetUrl }: { evidence: unknown; targetUrl: string | null }) {
  const data = record(evidence);
  const metrics = record(data.metrics);
  const page = record(data.page);
  const signals = Array.isArray(data.signals)
    ? data.signals.filter((signal): signal is string => typeof signal === "string")
    : [];

  const facts: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    const displayed = displayValue(value);
    if (displayed) facts.push({ label, value: displayed });
  };

  add("Position", metrics.position);
  add("Impressions", metrics.impressions);
  add("Clicks", metrics.clicks);
  add("CTR", metrics.ctr);
  add("Expected CTR", metrics.expected_ctr);
  add("CTR gap", metrics.ctr_gap);
  add("Current clicks", metrics.current_clicks);
  add("Previous clicks", metrics.previous_clicks);
  add("Change", metrics.change_pct);
  add("Competing pages", metrics.competing_pages);
  add("Page title", metrics.page_title);
  add("Page words", metrics.page_words);
  add("Page score", metrics.page_content_score);
  add("Expected clicks", data.expected_clicks);
  add("Confidence", data.confidence);
  add("Page URL", page.url || targetUrl);

  if (facts.length === 0 && signals.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
        No structured metrics are stored for this action. Open the raw evidence if present.
      </p>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-border/60 bg-muted/10 p-3">
      <p className="font-data text-[10px] uppercase tracking-wide text-muted-foreground">Structured evidence</p>
      {signals.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {signals.map((signal) => (
            <span key={signal} className="rounded-md border border-border/60 bg-background px-2 py-0.5 font-data text-[10px] text-muted-foreground">
              {signal.replaceAll("_", " ")}
            </span>
          ))}
        </div>
      )}
      {facts.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {facts.map((fact) => <Fact key={`${fact.label}-${fact.value}`} label={fact.label} value={fact.value} />)}
        </div>
      )}
    </div>
  );
}
