"use client";

import Link from "next/link";
import { useState } from "react";
import { Bot, ClipboardList, FileText, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

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

const tabs = ["inbox", "actions", "drafts", "agent tasks"] as const;
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

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Summary label="Inbox" value={inboxActions.length + inboxTasks.length} icon={Inbox} />
        <Summary label="Open actions" value={actions.filter((action) => !["DISMISSED", "VERIFIED", "FAILED"].includes(action.status)).length} icon={ClipboardList} />
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
              {value === "inbox"
                ? inboxActions.length + inboxTasks.length
                : value === "actions"
                  ? actions.length
                  : value === "drafts"
                    ? drafts.length
                    : agentTasks.length}
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
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{action.recommendation}</p>
      <p className="mt-1 font-data text-[10px] text-muted-foreground/70">
        {action.targetUrl || action.primaryQuery || action.kind}
        {action.drafts > 0 ? ` · ${action.drafts} draft${action.drafts === 1 ? "" : "s"}` : ""}
        {action.agentTasks > 0 ? ` · ${action.agentTasks} task${action.agentTasks === 1 ? "" : "s"}` : ""}
      </p>
    </Link>
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
