"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AgentTaskActions({
  taskId,
  status,
  commitSha,
}: {
  taskId: string;
  status: string;
  commitSha: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sha, setSha] = useState(commitSha);

  async function request(path: string, method: "PATCH" | "POST", body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Request failed");
      if (payload.task?.commitSha) setSha(payload.task.commitSha);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "AWAITING_REVIEW" && (
        <>
          <Button size="xs" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}`, "PATCH", { status: "APPROVED" }, "approve")} disabled={Boolean(busy)}>
            {busy === "approve" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            Approve
          </Button>
          <Button variant="outline" size="xs" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}`, "PATCH", { status: "CHANGES_REQUESTED" }, "changes")} disabled={Boolean(busy)}>
            {busy === "changes" ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
            Request changes
          </Button>
        </>
      )}
      {status === "APPROVED" && (
        <Button size="xs" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}/commit`, "POST", {}, "commit")} disabled={Boolean(busy)}>
          {busy === "commit" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Commit changes
        </Button>
      )}
      {sha && <span className="font-data text-[10px] text-muted-foreground">commit {sha.slice(0, 10)}</span>}
      {status === "CLOSED" && <span className="font-data text-[10px] text-signal">closed</span>}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}
