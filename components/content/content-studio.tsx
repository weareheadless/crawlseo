"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  PenLine,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ContentAction,
  ContentActionFormat,
  ContentActionPlan,
} from "@/lib/ai-seo/action-plan";
import type { ContentDraftView } from "@/lib/ai-seo/drafts";

type Filter = "all" | ContentActionFormat;

const formatLabels: Record<ContentActionFormat, string> = {
  article: "Article",
  page_update: "Page update",
  metadata: "Metadata",
};

const kindLabels: Record<string, string> = {
  improve_metadata: "Rewrite metadata",
  improve_page: "Improve page",
  create_article: "New article",
  refresh_decaying_page: "Refresh page",
  consolidate_pages: "Consolidate",
};

function wordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function compact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function safePath(value: string | null): string {
  if (!value) return "No target URL";
  try {
    const url = new URL(value);
    return url.pathname === "/" ? url.hostname : `${url.hostname}${url.pathname}`;
  } catch {
    return value;
  }
}

function evidenceChips(action: ContentAction): string[] {
  const evidence = action.evidence;
  const chips: string[] = [];
  if (typeof evidence.position === "number") chips.push(`Pos ${evidence.position}`);
  if (typeof evidence.impressions === "number") chips.push(`${compact(evidence.impressions)} impr.`);
  if (typeof evidence.ctr === "number") chips.push(`${evidence.ctr}% CTR`);
  if (typeof evidence.ctr_gap === "number") chips.push(`+${evidence.ctr_gap} pp gap`);
  if (typeof evidence.current_clicks === "number" && typeof evidence.previous_clicks === "number") {
    chips.push(`${evidence.previous_clicks} → ${evidence.current_clicks} clicks`);
  }
  if (typeof evidence.competing_pages === "number") chips.push(`${evidence.competing_pages} URLs`);
  if (typeof evidence.page_words === "number") chips.push(`${compact(evidence.page_words)} words`);
  return chips.slice(0, 5);
}

function scoreTone(score: number): string {
  if (score >= 70) return "bg-primary/10 text-primary";
  if (score >= 55) return "bg-warning/15 text-warning";
  return "bg-muted text-muted-foreground";
}

function inlineText(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let blockIndex = 0;

  function flushList() {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`list-${blockIndex++}`} className="my-3 list-disc space-y-1 pl-5 text-sm leading-6 text-foreground/90">
        {list.map((item, index) => <li key={index}>{inlineText(item)}</li>)}
      </ul>,
    );
    list = [];
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    if (line.startsWith("### ")) {
      blocks.push(<h4 key={`h4-${blockIndex++}`} className="mt-4 font-heading text-sm font-semibold text-foreground">{inlineText(line.slice(4))}</h4>);
    } else if (line.startsWith("## ")) {
      blocks.push(<h3 key={`h3-${blockIndex++}`} className="mt-5 font-heading text-base font-semibold text-foreground">{inlineText(line.slice(3))}</h3>);
    } else if (line.startsWith("# ")) {
      blocks.push(<h2 key={`h2-${blockIndex++}`} className="mt-2 font-heading text-xl font-semibold text-foreground">{inlineText(line.slice(2))}</h2>);
    } else {
      blocks.push(<p key={`p-${blockIndex++}`} className="my-2 text-sm leading-6 text-foreground/90">{inlineText(line)}</p>);
    }
  }
  flushList();
  return <div>{blocks}</div>;
}

export function ContentStudio({
  siteId,
  domain,
  plan,
  initialDrafts,
  writerReady,
  initialSelectedActionId,
}: {
  siteId: string;
  domain: string;
  plan: ContentActionPlan;
  initialDrafts: ContentDraftView[];
  writerReady: boolean;
  initialSelectedActionId: string | null;
}) {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [selectedActionId, setSelectedActionId] = useState(
    plan.actions.some((action) => action.id === initialSelectedActionId) ? initialSelectedActionId : plan.actions[0]?.id ?? null,
  );
  const [selectedDraftId, setSelectedDraftId] = useState(initialDrafts[0]?.id ?? null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [instructions, setInstructions] = useState("");
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const filteredActions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return plan.actions.filter((action) => {
      if (filter !== "all" && action.format !== filter) return false;
      if (!needle) return true;
      return [action.title, action.primaryQuery, action.targetUrl, action.kind]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [plan.actions, filter, query]);

  const selectedAction = plan.actions.find((action) => action.id === selectedActionId) ?? null;
  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? null;

  async function generateDraft() {
    if (!selectedAction || generatingId) return;
    setGeneratingId(selectedAction.id);
    setError(null);
    try {
      const response = await fetch(`/crawlseo/api/sites/${siteId}/content-studio/drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          opportunityKey: selectedAction.id,
          instructions: instructions.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        draft?: ContentDraftView;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !payload.draft) {
        throw new Error(payload.error
          ? `${payload.error}${payload.detail ? ` — ${payload.detail}` : ""}`
          : "Draft generation failed");
      }
      setDrafts((current) => [payload.draft!, ...current]);
      setSelectedDraftId(payload.draft.id);
      setInstructions("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Draft generation failed");
    } finally {
      setGeneratingId(null);
    }
  }

  async function copyDraft() {
    if (!selectedDraft) return;
    try {
      await navigator.clipboard.writeText(selectedDraft.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Could not copy the draft to the clipboard");
    }
  }

  function downloadDraft() {
    if (!selectedDraft) return;
    const blob = new Blob([selectedDraft.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selectedDraft.slug || "content-draft"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Summary label="Priority actions" value={plan.summary.total} />
        <Summary label="High priority" value={plan.summary.highPriority} />
        <Summary label="Expected clicks" value={compact(plan.summary.expectedClicks)} />
        <Summary label="Saved drafts" value={drafts.length} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="panel overflow-hidden">
          <div className="border-b border-border/60 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Action queue
                </p>
                <h2 className="mt-1 font-heading text-lg font-semibold">What to fix next</h2>
              </div>
              <div className="flex flex-wrap gap-1">
                {(["all", "article", "page_update", "metadata"] as Filter[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setFilter(value)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
                      filter === value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {value === "all" ? "All" : formatLabels[value]}
                  </button>
                ))}
              </div>
            </div>
            <div className="relative mt-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by query or URL"
                className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <div className="max-h-[420px] space-y-2 overflow-y-auto p-3">
            {filteredActions.length === 0 ? (
              <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                No actions match this filter.
              </p>
            ) : filteredActions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => setSelectedActionId(action.id)}
                className={cn(
                  "w-full rounded-xl border p-3 text-left transition",
                  selectedActionId === action.id
                    ? "border-primary bg-primary/5"
                    : "border-border/70 hover:border-primary/40 hover:bg-muted/25",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {formatLabels[action.format]}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{kindLabels[action.kind]}</span>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium text-foreground">{action.title}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{safePath(action.targetUrl)}</p>
                  </div>
                  <span className={cn("shrink-0 rounded-lg px-2 py-1 font-data text-xs font-semibold", scoreTone(action.score))}>
                    {action.score}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {selectedAction && (
            <div className="border-t border-border/60 bg-muted/15 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Selected action
                  </p>
                  <h3 className="mt-1 font-heading text-base font-semibold">{selectedAction.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{selectedAction.recommendedAction}</p>
                </div>
                <div className="flex shrink-0 gap-2 text-center">
                  <MiniMetric label="Impact" value={selectedAction.impact} />
                  <MiniMetric label="Confidence" value={selectedAction.confidence} />
                  <MiniMetric label="Effort" value={selectedAction.effort} />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {evidenceChips(selectedAction).map((chip) => (
                  <span key={chip} className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground">
                    {chip}
                  </span>
                ))}
                <span className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground">
                  {selectedAction.intent}
                </span>
              </div>

              {selectedAction.page?.title && (
                <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">
                  Current title: <span className="text-foreground/80">{selectedAction.page.title}</span>
                </p>
              )}

              <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground" htmlFor="draft-instructions">
                Editor instructions
              </label>
              <textarea
                id="draft-instructions"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={`Optional. Example: keep the ${domain} tone, mention the existing service area, avoid price claims.`}
                className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/55 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />

              {!writerReady && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <p>
                    The writer is not configured. Set <code className="font-data text-foreground">CONTENT_LLM_API_KEY</code>{" "}
                    (or <code className="font-data text-foreground">OPENAI_API_KEY</code>) on the CrawlSEO server.
                  </p>
                </div>
              )}

              {error && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <p>{error}</p>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button onClick={generateDraft} disabled={!writerReady || Boolean(generatingId)}>
                  {generatingId === selectedAction.id
                    ? <Loader2 className="size-4 animate-spin" />
                    : <Sparkles className="size-4" />}
                  {generatingId === selectedAction.id ? "Writing draft…" : "Write draft"}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Draft only · no CMS or site change
                </span>
              </div>
            </div>
          )}
        </section>

        <section className="panel overflow-hidden">
          <div className="border-b border-border/60 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Review queue
            </p>
            <h2 className="mt-1 font-heading text-lg font-semibold">Saved drafts</h2>
          </div>

          {drafts.length === 0 ? (
            <div className="p-8 text-center">
              <PenLine className="mx-auto size-7 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium">No drafts yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose an action and write the first reviewable draft.
              </p>
            </div>
          ) : (
            <div className="grid min-h-[520px] grid-rows-[auto_minmax(0,1fr)]">
              <div className="max-h-[190px] space-y-1 overflow-y-auto border-b border-border/60 p-2">
                {drafts.map((draft) => (
                  <button
                    key={draft.id}
                    type="button"
                    onClick={() => setSelectedDraftId(draft.id)}
                    className={cn(
                      "flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left transition",
                      selectedDraftId === draft.id ? "bg-primary/10" : "hover:bg-muted/30",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-foreground">{draft.title}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {formatLabels[draft.format as ContentActionFormat] ?? draft.format} · {new Date(draft.createdAt).toLocaleString()}
                      </span>
                    </span>
                    <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>

              {selectedDraft && (
                <div className="min-h-0 overflow-y-auto p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-heading text-lg font-semibold leading-snug">{selectedDraft.title}</h3>
                      <p className="mt-1 font-data text-[11px] text-muted-foreground">/{selectedDraft.slug}</p>
                    </div>
                    <div className="flex gap-1.5">
                      <Button variant="outline" size="xs" onClick={copyDraft}>
                        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                        {copied ? "Copied" : "Copy"}
                      </Button>
                      <Button variant="outline" size="xs" onClick={downloadDraft}>
                        <Download className="size-3" />
                        .md
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 text-xs">
                    <div>
                      <p className="font-semibold uppercase tracking-[0.1em] text-muted-foreground">Meta title</p>
                      <p className="mt-1 text-foreground/90">{selectedDraft.metaTitle}</p>
                    </div>
                    <div>
                      <p className="font-semibold uppercase tracking-[0.1em] text-muted-foreground">Meta description</p>
                      <p className="mt-1 text-foreground/90">{selectedDraft.metaDescription}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                      <span>{wordCount(selectedDraft.markdown).toLocaleString()} words</span>
                      <span>·</span>
                      <span>{selectedDraft.provider}</span>
                      <span>·</span>
                      <span>{selectedDraft.model}</span>
                    </div>
                  </div>

                  <div className="mt-4">
                    <MarkdownPreview markdown={selectedDraft.markdown} />
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel p-4">
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-heading text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">{label}</p>
      <p className="font-data text-xs font-semibold text-foreground">{value}</p>
    </div>
  );
}
