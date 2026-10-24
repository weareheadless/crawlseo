"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

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
}: {
  taskId: string;
  status: string;
  startedAt: string | null;
  result: unknown;
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
  const lines = useMemo(() => (progress?.lines ?? []).slice(-40), [progress?.lines]);

  if (task.status !== "RUNNING" && !progress) return null;

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
