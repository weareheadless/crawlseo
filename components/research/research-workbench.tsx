"use client";

import { useState } from "react";
import { Check, Loader2, Play, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RunView = {
  id: string;
  title: string;
  kind: string;
  trigger: string;
  status: string;
  topics: string[];
  providerSet: string[];
  sourceCount: number;
  findingCount: number;
  actionCount: number;
  createdAt: string;
};

type ActionView = {
  id: string;
  title: string;
  source: string;
  kind: string;
  format: string | null;
  recommendation: string;
  status: string;
  priority: number;
  automationMode: string;
  targetUrl: string | null;
  primaryQuery: string | null;
  createdAt: string;
  drafts: number;
  deliveries: number;
};

const statusTone: Record<string, string> = {
  PROPOSED: "bg-warning/15 text-warning",
  APPROVED: "bg-primary/10 text-primary",
  DRAFTING: "bg-primary/10 text-primary",
  DRAFT_READY: "bg-primary/10 text-primary",
  DISMISSED: "bg-muted text-muted-foreground",
  DELIVERED: "bg-signal/10 text-signal",
  VERIFIED: "bg-signal/10 text-signal",
  FAILED: "bg-danger/15 text-danger",
};

export function ResearchWorkbench({
  siteId,
  initialRuns,
  initialActions,
}: {
  siteId: string;
  initialRuns: RunView[];
  initialActions: ActionView[];
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [actions, setActions] = useState(initialActions);
  const [title, setTitle] = useState("");
  const [topics, setTopics] = useState("");
  const [audience, setAudience] = useState("");
  const [market, setMarket] = useState("");
  const [questions, setQuestions] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatingAction, setUpdatingAction] = useState<string | null>(null);

  async function createRun(event: React.FormEvent) {
    event.preventDefault();
    const topicList = topics.split(",").map((item) => item.trim()).filter(Boolean);
    if (!title.trim() || topicList.length === 0) {
      setError("Add a title and at least one topic.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(`/crawlseo/api/sites/${siteId}/research/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          topics: topicList,
          audience: audience.trim() || undefined,
          market: market.trim() || undefined,
          questions: questions.split("\n").map((item) => item.trim()).filter(Boolean),
          providers: ["reddit", "news", "web"],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not create research run");
      setRuns((current) => [{
        id: payload.run.id,
        title: payload.run.title,
        kind: payload.run.kind,
        trigger: payload.run.trigger,
        status: payload.run.status,
        topics: topicList,
        providerSet: ["reddit", "news", "web"],
        sourceCount: 0,
        findingCount: 0,
        actionCount: 0,
        createdAt: payload.run.createdAt,
      }, ...current]);
      setTitle("");
      setTopics("");
      setAudience("");
      setMarket("");
      setQuestions("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create research run");
    } finally {
      setCreating(false);
    }
  }

  async function setActionStatus(actionId: string, status: "APPROVED" | "DISMISSED") {
    setUpdatingAction(actionId);
    setError(null);
    try {
      const response = await fetch(`/crawlseo/api/actions/${actionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not update action");
      setActions((current) => current.map((action) =>
        action.id === actionId ? { ...action, status: payload.action.status } : action,
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update action");
    } finally {
      setUpdatingAction(null);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <section className="panel p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          New research run
        </p>
        <h2 className="mt-1 font-heading text-lg font-semibold">Ask the engine</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the market question. The provider worker will collect sources and turn findings into actions.
        </p>

        <form onSubmit={createRun} className="mt-5 space-y-3">
          <Field label="Title">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Buyer concerns in Tulum"
              className={inputClass}
            />
          </Field>
          <Field label="Topics">
            <input
              value={topics}
              onChange={(event) => setTopics(event.target.value)}
              placeholder="Tulum real estate, property ownership"
              className={inputClass}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Audience">
              <input
                value={audience}
                onChange={(event) => setAudience(event.target.value)}
                placeholder="international buyers"
                className={inputClass}
              />
            </Field>
            <Field label="Market">
              <input
                value={market}
                onChange={(event) => setMarket(event.target.value)}
                placeholder="Mexico"
                className={inputClass}
              />
            </Field>
          </div>
          <Field label="Questions">
            <textarea
              value={questions}
              onChange={(event) => setQuestions(event.target.value)}
              rows={3}
              placeholder={"What concerns do buyers repeatedly raise?\nWhat misinformation is common?"}
              className={`${inputClass} resize-y`}
            />
          </Field>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
              <X className="mt-0.5 size-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          <Button type="submit" disabled={creating}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {creating ? "Creating…" : "Create research run"}
          </Button>
        </form>

        <div className="mt-6 border-t border-border/60 pt-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-heading text-sm font-semibold">Recent runs</h3>
            <span className="font-data text-[10px] text-muted-foreground">{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No research runs yet.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {runs.map((run) => (
                <div key={run.id} className="rounded-xl border border-border/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{run.title}</p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {run.topics.join(" · ")}
                      </p>
                    </div>
                    <span className="rounded-md bg-muted px-2 py-1 font-data text-[10px] uppercase text-muted-foreground">
                      {run.status.toLowerCase()}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 font-data text-[10px] text-muted-foreground">
                    <span>{run.sourceCount} sources</span>
                    <span>{run.findingCount} findings</span>
                    <span>{run.actionCount} actions</span>
                    <span>{run.providerSet.join(", ") || "providers pending"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-border/60 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Work queue
          </p>
          <h2 className="mt-1 font-heading text-lg font-semibold">Actions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Approve or dismiss proposed work. Content generation and delivery follow in later phases.
          </p>
        </div>

        {actions.length === 0 ? (
          <div className="p-8 text-center">
            <Play className="mx-auto size-7 text-muted-foreground/50" />
            <p className="mt-3 text-sm font-medium">No actions yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Actions appear after a research run produces findings.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {actions.map((action) => (
              <div key={action.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{action.title}</p>
                      <span className={cn(
                        "rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        statusTone[action.status] ?? "bg-muted text-muted-foreground",
                      )}>
                        {action.status.toLowerCase().replaceAll("_", " ")}
                      </span>
                      <span className="font-data text-[10px] text-muted-foreground">
                        priority {action.priority}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{action.recommendation}</p>
                    <p className="mt-1 font-data text-[10px] text-muted-foreground/70">
                      {action.source} · {action.kind}
                      {action.targetUrl ? ` · ${action.targetUrl}` : ""}
                    </p>
                  </div>
                  {action.status === "PROPOSED" && (
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={updatingAction === action.id}
                        onClick={() => setActionStatus(action.id, "APPROVED")}
                      >
                        {updatingAction === action.id ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                        Approve
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={updatingAction === action.id}
                        onClick={() => setActionStatus(action.id, "DISMISSED")}
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/55 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
