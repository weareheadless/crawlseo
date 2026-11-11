"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, Loader2, MessageSquare, Play, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { acceptsAgentFollowUp } from "@/lib/agent-tasks/transitions";
import { AGENT_RUN_REQUESTED_EVENT } from "@/lib/agent-tasks/run-event";
import type { AgentProgressState } from "@/lib/agent-tasks/progress";

/**
 * The run and the conversation around it, on the page the operator already
 * has open. The server render seeds it; while a run is in flight it polls the
 * progress endpoint, and when the run stops it refreshes the page so the
 * preview and the review actions appear without a manual reload.
 */

export type AgentChatMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

type ProgressResponse = {
  task: {
    status: string;
    errorCode: string | null;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
    progress: AgentProgressState;
    previewAt: string | null;
  };
  messages: AgentChatMessage[];
  job: { status: string; attempts: number; maxAttempts: number; errorCode: string | null } | null;
};

const STATUS_TONE: Record<string, string> = {
  RUNNING: "bg-primary/10 text-primary",
  READY: "bg-muted text-muted-foreground",
  CHANGES_REQUESTED: "bg-warning/15 text-warning",
  AWAITING_REVIEW: "bg-warning/15 text-warning",
  AWAITING_TARGET: "bg-warning/15 text-warning",
  FAILED: "bg-danger/15 text-danger",
  PUBLISHED: "bg-signal/10 text-signal",
};

const ROLE_LABEL: Record<string, string> = {
  HUMAN: "You",
  AGENT: "Agent",
  SYSTEM: "System",
};

const BUSY_JOB = new Set(["PENDING", "RUNNING"]);

function clock(value: string): string {
  // UTC, so the server render and the first client paint agree.
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(value);
  return match?.[1] ?? "";
}

function elapsed(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export function AgentRunConsole({
  taskId,
  initialStatus,
  initialProgress,
  initialMessages,
  initialJobStatus,
}: {
  taskId: string;
  initialStatus: string;
  initialProgress: AgentProgressState;
  initialMessages: AgentChatMessage[];
  initialJobStatus: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [stage, setStage] = useState(initialProgress.stage);
  const [lines, setLines] = useState(initialProgress.lines);
  const [dropped, setDropped] = useState(initialProgress.dropped);
  const [startedAt, setStartedAt] = useState(initialProgress.startedAt);
  const [messages, setMessages] = useState(initialMessages);
  const [jobStatus, setJobStatus] = useState(initialJobStatus);
  const [runRequested, setRunRequested] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const polling = runRequested || status === "RUNNING" || BUSY_JOB.has(jobStatus ?? "");

  // A run is queued by the action bar, which is a different component. The
  // event lets the console start reporting immediately instead of waiting for
  // the worker to flip the task to RUNNING.
  useEffect(() => {
    const onRunRequested = () => {
      setRunRequested(true);
      setStatus("RUNNING");
      setStage("Queued");
    };
    window.addEventListener(AGENT_RUN_REQUESTED_EVENT, onRunRequested);
    return () => window.removeEventListener(AGENT_RUN_REQUESTED_EVENT, onRunRequested);
  }, []);

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const response = await fetch(`/crawlseo/api/agent-tasks/${taskId}/progress`, { cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as ProgressResponse;
          if (stopped) return;
          setStatus(body.task.status);
          setStage(body.task.progress.stage);
          setLines(body.task.progress.lines);
          setDropped(body.task.progress.dropped);
          setStartedAt(body.task.progress.startedAt);
          setMessages((previous) => mergeMessages(previous, body.messages));
          setJobStatus(body.job?.status ?? null);
          const working = body.task.status === "RUNNING" || BUSY_JOB.has(body.job?.status ?? "");
          if (!working) {
            setRunRequested(false);
            // The run wrote its artifacts; load the preview and actions.
            router.refresh();
            return;
          }
        }
      } catch {
        // A dropped poll is transient; keep the console on its last state.
      }
      if (!stopped) timer = setTimeout(tick, 2_000);
    };

    timer = setTimeout(tick, 600);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, taskId, router]);

  useEffect(() => {
    if (!polling) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [polling]);

  useEffect(() => {
    const element = logRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const jumpToLatest = () => {
    stickToBottom.current = true;
    setAtBottom(true);
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  async function sendMessage() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/crawlseo/api/agent-tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: AgentChatMessage;
        systemMessage?: AgentChatMessage | null;
        queued?: boolean;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not send that note");
      setDraft("");
      setMessages((previous) =>
        mergeMessages(
          previous,
          [body.message, body.systemMessage].filter((message): message is AgentChatMessage => Boolean(message)),
        ),
      );
      if (body.queued) {
        setRunRequested(true);
        setStatus("RUNNING");
        setStage("Queued");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that note");
    } finally {
      setSending(false);
    }
  }

  const canChat = acceptsAgentFollowUp(status);
  const chatHint = status === "RUNNING"
    ? "The agent is working. When the run finishes, tell it what to correct."
    : status === "PUBLISHING"
      ? "A delivery is in flight. You can ask for changes once it finishes."
      : status === "CANCELLED" || status === "COMPLETED"
        ? "This task is finished; start a new task for further changes."
        : "Ask the agent to change something. It starts a new run with your note.";

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="font-heading text-base font-semibold">Agent run</h2>
          <span
            className={`rounded-md px-2 py-0.5 font-data text-[10px] uppercase tracking-wide ${
              STATUS_TONE[status] ?? "bg-muted text-muted-foreground"
            }`}
          >
            {polling ? "running" : status.replaceAll("_", " ")}
          </span>
          {stage && (lines.length > 0 || polling) && (
            <span className="text-[11px] text-muted-foreground">{stage}</span>
          )}
          {polling && startedAt && now > 0 && (
            <span className="font-data text-[11px] text-muted-foreground">{elapsed(startedAt, now)}</span>
          )}
        </div>
        <span className="font-data text-[10px] uppercase tracking-wide text-muted-foreground">
          {polling ? "Live" : "Stopped"}
        </span>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="relative border-b border-border/60 lg:border-b-0 lg:border-r">
          <div
            ref={logRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              const next = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
              stickToBottom.current = next;
              setAtBottom((previous) => (previous === next ? previous : next));
            }}
            className="h-[420px] overflow-auto bg-muted/20 px-4 py-3 font-data text-[11px] leading-5"
          >
            {dropped > 0 && (
              <p className="mb-2 text-muted-foreground">
                {dropped} earlier line{dropped === 1 ? "" : "s"} not shown.
              </p>
            )}
            {lines.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <Play className="size-4" />
                <p>{polling ? "Starting the agent…" : "No run yet. Run the agent to watch it work here."}</p>
              </div>
            ) : (
              <ol className="space-y-0.5">
                {lines.map((line, index) => (
                  <li key={`${line.at}-${index}`} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground/70">{clock(line.at)}</span>
                    <span className={line.message.startsWith("Agent:") ? "text-foreground" : "text-foreground/80"}>
                      {line.message}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {!atBottom && lines.length > 0 && (
            <button
              type="button"
              onClick={jumpToLatest}
              className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground shadow-sm"
            >
              <ArrowDown className="size-3" /> Latest
            </button>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <div className="h-[240px] overflow-auto px-4 py-3">
            {messages.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No conversation yet. Review notes and the agent&apos;s summary appear here.
              </p>
            ) : (
              <div className="space-y-2">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-lg border p-2 text-xs ${
                      message.role === "HUMAN"
                        ? "border-primary/30 bg-primary/5"
                        : message.role === "SYSTEM"
                          ? "border-border/50 bg-muted/20 text-muted-foreground"
                          : "border-border/60"
                    }`}
                  >
                    <p className="font-data text-[9px] uppercase tracking-wide text-muted-foreground">
                      {ROLE_LABEL[message.role] ?? message.role}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap">{message.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-auto border-t border-border/60 p-3">
            {canChat ? (
              <div className="space-y-2">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendMessage();
                  }}
                  rows={2}
                  placeholder="Tell the agent what to correct…"
                  className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/60"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">{chatHint}</p>
                  <Button size="sm" onClick={() => void sendMessage()} disabled={sending || !draft.trim()}>
                    {sending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
                    Send &amp; run
                  </Button>
                </div>
              </div>
            ) : (
              <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
                <MessageSquare className="mt-0.5 size-3 shrink-0" />
                {chatHint}
              </p>
            )}
            {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Keep one row per message when a poll overlaps an optimistic append. */
function mergeMessages(previous: AgentChatMessage[], incoming: AgentChatMessage[]): AgentChatMessage[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
