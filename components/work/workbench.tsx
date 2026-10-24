"use client";

import Link from "next/link";
import { useState } from "react";
import { Bot, ClipboardList, FileText, Inbox, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KeywordEvidenceSummary } from "@/lib/research/evidence";
import {
  opportunitySignalLabel,
  type OpportunityPriority,
} from "@/lib/ai-seo/opportunity-priority";

type ActionRow = {
  id: string;
  title: string;
  source: string;
  kind: string;
  format: string | null;
  status: string;
  priority: number;
  targetUrl: string | null;
  primaryQuery: string | null;
  recommendation: string;
  createdAt: string;
  evidenceSources: number;
  keyword: KeywordEvidenceSummary | null;
  opportunity: OpportunityPriority | null;
  editorialDecision: string | null;
  drafts: number;
  agentTasks: number;
  deliveries: number;
};

type DraftRow = {
  id: string;
  actionId: string | null;
  title: string;
  format: string;
  status: string;
  createdAt: string;
};

type TaskRow = {
  id: string;
  actionId: string | null;
  actionTitle: string | null;
  title: string;
  status: string;
  route: string | null;
  createdAt: string;
};

const tabs = ["inbox", "actions", "opportunities", "drafts", "agent tasks"] as const;
type Tab = (typeof tabs)[number];

const statusTone: Record<string, string> = {
  PROPOSED: "bg-warning/15 text-warning",
  APPROVED: "bg-primary/10 text-primary",
  DRAFTING: "bg-primary/10 text-primary",
  DRAFT_READY: "bg-primary/10 text-primary",
  AWAITING_REVIEW: "bg-warning/15 text-warning",
  CHANGES_REQUESTED: "bg-warning/15 text-warning",
  READY: "bg-primary/10 text-primary",
  RUNNING: "bg-primary/10 text-primary",
  COMPLETED: "bg-signal/10 text-signal",
  PUBLISHED: "bg-signal/10 text-signal",
  CLOSED: "bg-muted text-muted-foreground",
  FAILED: "bg-danger/15 text-danger",
};

export function Workbench({
  siteId,
  initialTab = "inbox",
  actions,
  drafts,
  agentTasks,
}: {
  siteId: string;
  initialTab?: Tab;
  actions: ActionRow[];
  drafts: DraftRow[];
  agentTasks: TaskRow[];
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const inboxActions = actions.filter((action) =>
    ["PROPOSED", "DRAFT_READY", "APPROVED"].includes(action.status),
  );
  const inboxTasks = agentTasks.filter((task) =>
    ["AWAITING_REVIEW", "CHANGES_REQUESTED", "READY"].includes(task.status),
  );
  const opportunities = actions.filter((action) => action.opportunity);
  const counts: Record<Tab, number> = {
    inbox: inboxActions.length + inboxTasks.length,
    actions: actions.length,
    opportunities: opportunities.length,
    drafts: drafts.length,
    "agent tasks": agentTasks.length,
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Summary label="Inbox" value={counts.inbox} icon={Inbox} />
        <Summary label="Open actions" value={actions.filter((action) => !["DISMISSED", "VERIFIED", "FAILED"].includes(action.status)).length} icon={ClipboardList} />
        <Summary label="Opportunities" value={counts.opportunities} icon={Target} />
        <Summary label="Drafts" value={drafts.length} icon={FileText} />
        <Summary label="Agent tasks" value={agentTasks.length} icon={Bot} />
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border/60 pb-2">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition",
              tab === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value}
            <span className="ml-1.5 font-data text-[10px] opacity-60">
              {counts[value]}
            </span>
          </button>
        ))}
      </div>

      {tab === "inbox" && (
        <div className="space-y-3">
          {inboxActions.length === 0 && inboxTasks.length === 0 ? (
            <Empty text="Nothing needs review." />
          ) : (
            <>
              {inboxActions.map((action) => <ActionCard key={action.id} siteId={siteId} action={action} />)}
              {inboxTasks.map((task) => <TaskCard key={task.id} siteId={siteId} task={task} />)}
            </>
          )}
        </div>
      )}

      {tab === "actions" && (
        <div className="space-y-2">
          {actions.length === 0 ? <Empty text="No actions yet." /> : actions.map((action) => (
            <ActionCard key={action.id} siteId={siteId} action={action} />
          ))}
        </div>
      )}

      {tab === "opportunities" && <OpportunitiesView siteId={siteId} actions={opportunities} />}

      {tab === "drafts" && (
        <div className="space-y-2">
          {drafts.length === 0 ? <Empty text="No content drafts yet." /> : drafts.map((draft) => (
            <Link
              key={draft.id}
              href={draft.actionId ? `/sites/${siteId}/actions/${draft.actionId}` : `/sites/${siteId}/content-studio`}
              className="panel flex items-start justify-between gap-3 p-4 transition hover:border-primary/40"
            >
              <div>
                <p className="text-sm font-medium">{draft.title}</p>
                <p className="mt-1 font-data text-[10px] text-muted-foreground">
                  {draft.format} · {new Date(draft.createdAt).toLocaleString()}
                </p>
              </div>
              <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase", statusTone[draft.status] ?? "bg-muted text-muted-foreground")}>
                {draft.status.toLowerCase()}
              </span>
            </Link>
          ))}
        </div>
      )}

      {tab === "agent tasks" && (
        <div className="space-y-2">
          {agentTasks.length === 0 ? <Empty text="No agent tasks yet." /> : agentTasks.map((task) => (
            <TaskCard key={task.id} siteId={siteId} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionCard({ siteId, action }: { siteId: string; action: ActionRow }) {
  return (
    <Link
      href={`/sites/${siteId}/actions/${action.id}`}
      className="panel block p-4 transition hover:border-primary/40"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{action.title}</span>
        <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase", statusTone[action.status] ?? "bg-muted text-muted-foreground")}>
          {action.status.toLowerCase().replaceAll("_", " ")}
        </span>
        <span className="font-data text-[10px] text-muted-foreground">priority {action.priority}</span>
        <span className="font-data text-[10px] text-muted-foreground">{action.source}</span>
        {action.editorialDecision && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-data text-[10px] text-primary">
            {action.editorialDecision.replaceAll("_", " ")}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{action.recommendation}</p>
      {action.opportunity && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-data text-[10px] text-muted-foreground">
          {action.opportunity.signals.map((signal) => (
            <span key={signal} className="rounded bg-muted px-1.5 py-0.5">{opportunitySignalLabel(signal)}</span>
          ))}
          {action.opportunity.expectedClicks != null && (
            <span className="text-signal">+{action.opportunity.expectedClicks.toLocaleString()} expected clicks</span>
          )}
        </p>
      )}
      {action.keyword && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-data text-[10px] text-muted-foreground">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">keyword research</span>
          <span>{action.keyword.keyword}</span>
          {action.keyword.volume != null && <span>· {action.keyword.volume.toLocaleString()}/mo</span>}
          {action.keyword.difficulty != null && <span>· difficulty {action.keyword.difficulty}</span>}
          {action.keyword.cpc != null && <span>· CPC ${action.keyword.cpc.toFixed(2)}</span>}
        </p>
      )}
      <p className="mt-1 font-data text-[10px] text-muted-foreground/70">
        {action.targetUrl || action.primaryQuery || action.kind}
        {action.evidenceSources > 0
          ? ` · ${action.evidenceSources} linked source${action.evidenceSources === 1 ? "" : "s"}`
          : action.source === "seo_opportunity"
            ? " · metric evidence in detail"
            : action.source === "crawl_issue"
              ? " · crawl evidence in detail"
              : action.source === "keyword_research"
                ? " · keyword evidence in detail"
                : " · no linked sources"}
        {action.drafts > 0 ? ` · ${action.drafts} draft${action.drafts === 1 ? "" : "s"}` : ""}
        {action.agentTasks > 0 ? ` · ${action.agentTasks} task${action.agentTasks === 1 ? "" : "s"}` : ""}
      </p>
    </Link>
  );
}

function OpportunitiesView({ siteId, actions }: { siteId: string; actions: ActionRow[] }) {
  const [signalFilter, setSignalFilter] = useState("all");
  const counts = {
    striking_distance: actions.filter((action) => action.opportunity?.signals.includes("striking_distance")).length,
    low_ctr: actions.filter((action) => action.opportunity?.signals.includes("low_ctr")).length,
    content_decay: actions.filter((action) => action.opportunity?.signals.includes("content_decay")).length,
    cannibalization: actions.filter((action) => action.opportunity?.signals.includes("cannibalization")).length,
  };
  const totalExpectedClicks = actions.reduce(
    (sum, action) => sum + (action.opportunity?.expectedClicks ?? 0),
    0,
  );
  const filtered = signalFilter === "all"
    ? actions
    : actions.filter((action) => action.opportunity?.signals.includes(signalFilter));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Mini label="Striking distance" value={counts.striking_distance} />
        <Mini label="Low CTR" value={counts.low_ctr} />
        <Mini label="Content decay" value={counts.content_decay} />
        <Mini label="Cannibalization" value={counts.cannibalization} />
      </div>

      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Measured upside</p>
          <p className="mt-0.5 font-heading text-xl font-semibold text-signal">+{totalExpectedClicks.toLocaleString()} expected clicks</p>
          <p className="mt-0.5 text-xs text-muted-foreground">From GSC position, CTR, decay, and cannibalization signals.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterButton active={signalFilter === "all"} onClick={() => setSignalFilter("all")}>All</FilterButton>
          {(["striking_distance", "low_ctr", "content_decay", "cannibalization"] as const).map((signal) => (
            <FilterButton key={signal} active={signalFilter === signal} onClick={() => setSignalFilter(signal)}>
              {opportunitySignalLabel(signal)}
            </FilterButton>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty text="No opportunities match this signal." />
      ) : (
        <div className="space-y-2">
          {filtered.map((action) => <OpportunityCard key={action.id} siteId={siteId} action={action} />)}
        </div>
      )}
    </div>
  );
}

function OpportunityCard({ siteId, action }: { siteId: string; action: ActionRow }) {
  const opportunity = action.opportunity;
  if (!opportunity) return null;
  const metrics: string[] = [];
  if (opportunity.position != null) metrics.push(`Position ${opportunity.position}`);
  if (opportunity.impressions != null) metrics.push(`${opportunity.impressions.toLocaleString()} impressions`);
  if (opportunity.ctr != null) metrics.push(`${opportunity.ctr}% CTR`);
  if (opportunity.expectedCtr != null) metrics.push(`${opportunity.expectedCtr}% expected`);
  if (opportunity.ctrGap != null) metrics.push(`${opportunity.ctrGap} pp CTR gap`);
  if (opportunity.currentClicks != null && opportunity.previousClicks != null) {
    metrics.push(`${opportunity.previousClicks} → ${opportunity.currentClicks} clicks`);
  }
  if (opportunity.changePct != null) metrics.push(`${opportunity.changePct}% change`);
  if (opportunity.competingPages != null) metrics.push(`${opportunity.competingPages} competing URLs`);

  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/sites/${siteId}/actions/${action.id}`} className="text-sm font-semibold hover:text-primary">
              {action.title}
            </Link>
            <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase", statusTone[action.status] ?? "bg-muted text-muted-foreground")}>
              {action.status.toLowerCase().replaceAll("_", " ")}
            </span>
            <span className="font-data text-[10px] text-muted-foreground">priority {action.priority}</span>
            {opportunity.expectedClicks != null && (
              <span className="rounded-md bg-signal/10 px-1.5 py-0.5 font-data text-[10px] font-semibold text-signal">
                +{opportunity.expectedClicks.toLocaleString()} clicks
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {opportunity.signals.map((signal) => (
              <span key={signal} className="rounded bg-muted px-1.5 py-0.5 font-data text-[10px] text-muted-foreground">
                {opportunitySignalLabel(signal)}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{action.recommendation}</p>
          {metrics.length > 0 && (
            <p className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 font-data text-[10px] text-muted-foreground/80">
              {metrics.map((metric) => <span key={metric}>{metric}</span>)}
            </p>
          )}
          {action.keyword && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-data text-[10px] text-muted-foreground">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">keyword research</span>
              <span>{action.keyword.keyword}</span>
              {action.keyword.volume != null && <span>· {action.keyword.volume.toLocaleString()}/mo</span>}
              {action.keyword.difficulty != null && <span>· difficulty {action.keyword.difficulty}</span>}
            </p>
          )}
        </div>
        <Link href={`/sites/${siteId}/actions/${action.id}`} className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground">
          Open action
        </Link>
      </div>

      <details className="mt-3 rounded-lg border border-border/60 bg-muted/10 p-3">
        <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">Why this priority</summary>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
          <MiniFact label="Work priority" value={String(action.priority)} />
          <MiniFact label="SEO score" value={String(opportunity.seoScore)} />
          <MiniFact label="Impact" value={String(opportunity.impact)} />
          <MiniFact label="Confidence" value={`${opportunity.confidence}%`} />
          <MiniFact label="Effort" value={String(opportunity.effort)} />
          {opportunity.keywordScore != null && <MiniFact label="Keyword score" value={String(opportunity.keywordScore)} />}
        </div>
        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
          The SEO score combines expected click impact (55%), evidence confidence (25%), and effort (20%). Work priority is the strongest attached signal, so keyword demand or market research can raise it above the SEO score.
        </p>
      </details>
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
        active ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="panel p-4">
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-heading text-2xl font-semibold">{value}</p>
    </div>
  );
}

function MiniFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-data text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs text-foreground/90">{value}</p>
    </div>
  );
}

function TaskCard({ siteId, task }: { siteId: string; task: TaskRow }) {
  return (
    <Link
      href={task.actionId ? `/sites/${siteId}/actions/${task.actionId}` : `/sites/${siteId}/work?tab=agent+tasks`}
      className="panel block p-4 transition hover:border-primary/40"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{task.title}</span>
        <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase", statusTone[task.status] ?? "bg-muted text-muted-foreground")}>
          {task.status.toLowerCase().replaceAll("_", " ")}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{task.actionTitle || "Standalone implementation task"}</p>
      <p className="mt-1 font-data text-[10px] text-muted-foreground/70">{task.route || "route not set"}</p>
    </Link>
  );
}

function Summary({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Inbox }) {
  return (
    <div className="panel flex items-center justify-between p-4">
      <div>
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
        <p className="mt-1 font-heading text-2xl font-semibold">{value}</p>
      </div>
      <Icon className="size-5 text-muted-foreground/50" />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="panel px-5 py-10 text-center text-sm text-muted-foreground">{text}</p>;
}
