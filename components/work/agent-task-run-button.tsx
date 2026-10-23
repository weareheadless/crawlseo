"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AgentTaskRunButton({ taskId, status }: { taskId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  if (!["READY", "CHANGES_REQUESTED"].includes(status) && !queued) {
    return (
      <span className="rounded-md bg-muted px-1.5 py-0.5 font-data text-[10px] uppercase text-muted-foreground">
        {status.toLowerCase().replaceAll("_", " ")}
      </span>
    );
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/crawlseo/api/agent-tasks/${taskId}/run`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not start agent");
      setQueued(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start agent");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="xs" variant="outline" onClick={run} disabled={busy || queued}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
        {queued ? "Agent queued" : "Run agent"}
      </Button>
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}
