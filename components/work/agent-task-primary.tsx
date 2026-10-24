"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Play, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AgentTaskPrimary({
  taskId,
  status,
  hasEmbedTarget,
  targetComponentTag,
  publishedUrl,
}: {
  taskId: string;
  status: string;
  hasEmbedTarget: boolean;
  targetComponentTag?: string | null;
  publishedUrl: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request(path: string, method: "PATCH" | "POST", body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Request failed");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const spinner = busy ? <Loader2 className="size-3 animate-spin" /> : null;

  if (status === "CLOSED") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-signal/10 px-2 py-1 text-[11px] font-medium text-signal">
          <Check className="size-3" /> Closed
        </span>
        {publishedUrl && (
          <Link href={publishedUrl} target="_blank" rel="noreferrer noopener" className="text-xs text-primary underline underline-offset-2">
            View live
          </Link>
        )}
        {error && <span className="text-[11px] text-danger">{error}</span>}
      </div>
    );
  }

  if (status === "READY" || status === "CHANGES_REQUESTED") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}/run`, "POST", {})} disabled={busy}>
          {spinner ?? <Play className="size-3" />}
          Run agent
        </Button>
        {status === "CHANGES_REQUESTED" && <span className="text-[11px] text-muted-foreground">Re-run to apply the follow-up.</span>}
        {error && <span className="text-[11px] text-danger">{error}</span>}
      </div>
    );
  }

  if (status === "AWAITING_REVIEW") {
    if (!hasEmbedTarget) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}`, "PATCH", { status: "APPROVED" })} disabled={busy}>
            {spinner ?? <Check className="size-3" />}
            Approve
          </Button>
          {error && <span className="text-[11px] text-danger">{error}</span>}
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}/approve-deploy`, "POST", {})} disabled={busy}>
            {spinner ?? <Rocket className="size-3" />}
            Approve &amp; update
          </Button>
          {targetComponentTag && <span className="text-[11px] text-muted-foreground">Updates {targetComponentTag}</span>}
        </div>
        <p className="text-[11px] text-muted-foreground">Commits, updates Wix, verifies, and closes this task.</p>
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  if (status === "APPROVED" || status === "COMMITTED") {
    if (hasEmbedTarget) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}/approve-deploy`, "POST", {})} disabled={busy}>
            {spinner ?? <Rocket className="size-3" />}
            Update Wix
          </Button>
          {targetComponentTag && <span className="text-[11px] text-muted-foreground">Updates {targetComponentTag}</span>}
          {error && <span className="text-[11px] text-danger">{error}</span>}
        </div>
      );
    }
    if (status === "APPROVED") {
      return (
        <Button size="sm" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}/commit`, "POST", {})} disabled={busy}>
          {spinner ?? <Check className="size-3" />}
          Commit changes
        </Button>
      );
    }
    return <span className="text-xs text-muted-foreground">Committed</span>;
  }

  if (status === "PUBLISHED") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}`, "PATCH", { status: "CLOSED" })} disabled={busy}>
          {spinner ?? <Check className="size-3" />}
          Close task
        </Button>
        {publishedUrl && (
          <Link href={publishedUrl} target="_blank" rel="noreferrer noopener" className="text-xs text-primary underline underline-offset-2">
            View live
          </Link>
        )}
      </div>
    );
  }

  return <span className="text-[11px] text-muted-foreground">{status.toLowerCase().replaceAll("_", " ")}</span>;
}
