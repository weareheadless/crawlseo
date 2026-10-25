"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ProgressLine = { at: string; message: string };
type ProgressState = {
  stage?: string;
  startedAt?: string;
  updatedAt?: string;
  lines?: ProgressLine[];
};

type TaskPayload = {
  status: string;
  startedAt: string | null;
  result: unknown;
};

type TaskResult = {
  outcome?: string;
  files?: string[];
  releaseableFiles?: string[];
  diffBytes?: number;
  summary?: string;
  resolution?: { status?: string; method?: string; removed_labels?: number; live_verified?: boolean };
  progress?: ProgressState;
};

function taskResultFrom(value: unknown): TaskResult {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as TaskResult
    : {};
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number") return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function outcomeCopy(status: string, result: TaskResult, errorCode?: string | null): { title: string; detail: string; tone: string } | null {
  if (status === "FAILED") {
    return {
      title: "Agent failed",
      detail: errorCode || "The agent did not complete. Open the notes below for the error.",
      tone: "border-danger/30 bg-danger/10 text-danger",
    };
  }
  if (status === "AWAITING_REVIEW" && result.outcome === "non_code_changes") {
    return {
      title: "Changes ready — non-code only",
      detail: `${result.files?.length ?? 0} file(s) changed, but none are releaseable site-code files. The site release pipeline will not apply these. Review the files or request a different approach. Nothing is committed or pushed.`,
      tone: "border-warning/30 bg-warning/10 text-warning",
    };
  }
  if (status === "AWAITING_REVIEW" && result.outcome === "changes_ready") {
    return {
      title: "Changes ready for review",
      detail: `${result.files?.length ?? 0} file(s) changed · ${formatBytes(result.diffBytes)} diff. Nothing is committed or pushed yet.`,
      tone: "border-signal/30 bg-signal/10 text-signal",
    };
  }
  if (status === "AWAITING_REVIEW") {
    return {
      title: "Changes ready for review",
      detail: `${result.files?.length ?? 0} file(s) changed. Review the notes and diff before approving.`,
      tone: "border-primary/30 bg-primary/10 text-primary",
    };
  }
  if (status === "CHANGES_REQUESTED" && (errorCode === "SUPERSEDED_BY_BLOG_UPDATE" || result.resolution?.status === "fixed")) {
    return {
      title: "Resolved — fixed in Wix Blog",
      detail: "The broken hashtag links were removed from the live post by a surgical Wix Blog content update. The repo scripts were not published.",
      tone: "border-signal/30 bg-signal/10 text-signal",
    };
  }
  if (status === "CHANGES_REQUESTED" && result.outcome === "no_changes") {
    return {
      title: "No changes produced",
      detail: "The agent could not make a safe code change. Read the final summary for the reason, then request a different approach or rerun with more specific instructions.",
      tone: "border-warning/30 bg-warning/10 text-warning",
    };
  }
  if (status === "CHANGES_REQUESTED") {
    return {
      title: "Changes requested",
      detail: errorCode ? `The last run stopped with ${errorCode}.` : "Review the notes below before rerunning.",
      tone: "border-warning/30 bg-warning/10 text-warning",
    };
  }
  return null;
}

function progressFrom(result: unknown): ProgressState | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const progress = (result as Record<string, unknown>).progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  return progress as ProgressState;
}

function elapsedLabel(startedAt: string | null | undefined, now: number): string {
  if (!startedAt) return "starting";
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return "starting";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function AgentTaskProgress({
  taskId,
  status,
  startedAt,
  result,
  errorCode,
}: {
  taskId: string;
  status: string;
  startedAt: string | null;
  result: unknown;
  errorCode?: string | null;
}) {
  const router = useRouter();
  const [task, setTask] = useState<TaskPayload>({ status, startedAt, result });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setTask({ status, startedAt, result });
  }, [status, startedAt, result]);

  useEffect(() => {
    if (!["READY", "RUNNING"].includes(task.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/crawlseo/api/agent-tasks/${taskId}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        const next = payload.task as TaskPayload | undefined;
        if (!next || cancelled) return;
        setTask(next);
        if (!["READY", "RUNNING"].includes(next.status)) router.refresh();
      } catch {
        // Keep polling; transient worker/API errors should not hide the task.
      }
    };
    const interval = setInterval(poll, 2_000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [task.status, taskId, router]);

  useEffect(() => {
    if (!["READY", "RUNNING"].includes(task.status)) return;
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, [task.status]);

  const progress = progressFrom(task.result);
  const resultState = taskResultFrom(task.result);
  const lines = useMemo(() => (progress?.lines ?? []).slice(-40), [progress?.lines]);
  const outcome = outcomeCopy(task.status, resultState, errorCode);
  const files = Array.isArray(resultState.files) ? resultState.files : [];

  if (task.status !== "RUNNING" && !progress && !outcome) return null;

  return (
    <div className="mt-3 rounded-lg border border-primary/25 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {task.status === "RUNNING" ? (
          <Loader2 className="size-3 animate-spin text-primary" />
        ) : null}
        <p className="text-xs font-medium text-foreground">
          {task.status === "RUNNING" ? "Agent running" : `Agent ${task.status.toLowerCase().replaceAll("_", " ")}`}
        </p>
        {progress?.stage && <span className="text-[11px] text-muted-foreground">{progress.stage}</span>}
        <span className="ml-auto font-data text-[10px] text-muted-foreground">
          {elapsedLabel(progress?.startedAt ?? task.startedAt, now)}
        </span>
      </div>
      {outcome && (
        <div className={cn("mt-2 rounded-md border px-3 py-2", outcome.tone)}>
          <p className="text-[11px] font-semibold">{outcome.title}</p>
          <p className="mt-0.5 text-[11px] leading-5 opacity-90">{outcome.detail}</p>
          {files.length > 0 && (
            <p className="mt-1 break-all font-data text-[10px] opacity-80">
              {files.slice(0, 8).join(", ")}{files.length > 8 ? ` +${files.length - 8} more` : ""}
            </p>
          )}
        </div>
      )}
      {resultState.summary && (
        <details className="mt-2 rounded border border-border/50 bg-background/60 px-2 py-1.5">
          <summary className="cursor-pointer font-data text-[10px] uppercase text-muted-foreground">Final agent summary</summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[10px] leading-5 text-foreground/80">
            {resultState.summary}
          </pre>
        </details>
      )}
      <div className="mt-2 max-h-44 overflow-y-auto rounded border border-border/50 bg-background/60 p-2">
        {lines.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Waiting for agent output…</p>
        ) : (
          <ul className="space-y-1">
            {lines.map((line, index) => (
              <li key={`${line.at}-${index}`} className="flex gap-2 font-data text-[10px] leading-4 text-muted-foreground">
                <span className="shrink-0 opacity-60">
                  {new Date(line.at).toLocaleTimeString(undefined, { hour12: false })}
                </span>
                <span className="break-words">{line.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
