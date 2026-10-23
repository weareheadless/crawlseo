"use client";

import { useState } from "react";
import { Loader2, Network } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AgentTaskBridgePlanButton({ taskId, disabled }: { taskId: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/crawlseo/api/agent-tasks/${taskId}/bridge-plan`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Bridge plan failed");
      setPlan(payload.plan);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bridge plan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" size="xs" onClick={run} disabled={busy || disabled}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Network className="size-3" />}
        Plan bridge
      </Button>
      {error && <p className="text-[11px] text-danger">{error}</p>}
      {plan !== null && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-[10px] leading-5">
          {JSON.stringify(plan, null, 2).slice(0, 8_000)}
        </pre>
      )}
    </div>
  );
}
