"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Network, Rocket, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

type Target = {
  key: string;
  componentTag: string | null;
  snippetId: string | null;
  sourcePath: string | null;
};

export function EmbedDeliveryControls({
  taskId,
  status,
  hasWorktree,
  targets,
  initialTargetKey,
}: {
  taskId: string;
  status: string;
  hasWorktree: boolean;
  targets: Target[];
  initialTargetKey?: string;
}) {
  const router = useRouter();
  const [targetKey, setTargetKey] = useState(initialTargetKey || targets[0]?.key || "");
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function call(path: string, body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `${label} failed`);
      if (label === "plan") setPlan(payload.plan ?? payload);
      if (label === "apply") {
        setPlan(payload.receipt ?? payload);
        router.refresh();
      }
      if (label === "deploy") {
        setPlan(payload);
        setNotice("Approved, committed, applied, and verified. Task closed.");
        router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  if (targets.length === 0) {
    return <p className="text-xs text-muted-foreground">No mapped embed targets. Run the delivery inventory script first.</p>;
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <p className="font-data text-[10px] uppercase tracking-wide text-muted-foreground">Embed delivery</p>
      <select
        value={targetKey}
        onChange={(event) => { setTargetKey(event.target.value); setPlan(null); }}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
      >
        {targets.map((target) => (
          <option key={target.key} value={target.key}>
            {target.componentTag} · {target.sourcePath}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap gap-2">
        {status === "AWAITING_REVIEW" && (
          <Button
            size="xs"
            disabled={!targetKey || !hasWorktree || Boolean(busy)}
            onClick={() => call(`/crawlseo/api/agent-tasks/${taskId}/approve-deploy`, { targetKey }, "deploy")}
          >
            {busy === "deploy" ? <Loader2 className="size-3 animate-spin" /> : <Rocket className="size-3" />}
            Approve &amp; deploy to Wix
          </Button>
        )}
        <Button
          variant="outline"
          size="xs"
          disabled={!targetKey || !hasWorktree || Boolean(busy)}
          onClick={() => call(`/crawlseo/api/agent-tasks/${taskId}/embed-plan`, { targetKey }, "plan")}
        >
          {busy === "plan" ? <Loader2 className="size-3 animate-spin" /> : <Network className="size-3" />}
          Plan embed
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={!targetKey || !hasWorktree || Boolean(busy)}
          onClick={() => call(`/crawlseo/api/agent-tasks/${taskId}/embed-verify`, { targetKey }, "verify")}
        >
          {busy === "verify" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Verify embed
        </Button>
        <Button
          size="xs"
          disabled={!targetKey || !hasWorktree || status !== "COMMITTED" || !plan || Boolean(busy)}
          onClick={() => {
            if (!window.confirm("Apply this embed packet to Wix now?")) return;
            void call(`/crawlseo/api/agent-tasks/${taskId}/embed-apply`, {
              targetKey,
              confirmation: `apply-embed:${taskId}:${targetKey}`,
            }, "apply");
          }}
        >
          {busy === "apply" ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
          Apply embed
        </Button>
      </div>
      {status === "AWAITING_REVIEW" && (
        <p className="text-[11px] text-muted-foreground">
          Approving commits the diff, applies the selected embed, verifies the live snippet, and closes the task.
        </p>
      )}
      {!hasWorktree && <p className="text-[11px] text-muted-foreground">Run the agent first to create a worktree.</p>}
      {notice && <p className="text-[11px] text-signal">{notice}</p>}
      {error && <p className="text-[11px] text-danger">{error}</p>}
      {plan !== null && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-[10px] leading-5">
          {JSON.stringify(plan, null, 2).slice(0, 8_000)}
        </pre>
      )}
    </div>
  );
}
