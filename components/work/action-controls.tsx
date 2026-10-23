"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Check, FileText, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isWixBlogTarget } from "@/lib/agent-tasks/targets";

export function ActionControls({
  actionId,
  initialStatus,
  format,
  targetUrl,
  hasDraft,
}: {
  actionId: string;
  initialStatus: string;
  format: string | null;
  targetUrl: string | null;
  hasDraft: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function call(path: string, body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(path, {
        method: label === "approve" || label === "dismiss" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Request failed");
      if (label === "approve" || label === "dismiss") {
        setStatus(payload.action?.status ?? status);
      } else if (label === "draft") {
        setNotice(`Draft ready: ${payload.draft?.title ?? "content draft"}`);
      } else if (label === "agent") {
        setNotice(`Agent task ready: ${payload.task?.id ?? ""}`);
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const canAgent = format !== "article" && !isWixBlogTarget(targetUrl);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status === "PROPOSED" && (
          <>
            <Button size="sm" disabled={Boolean(busy)} onClick={() => call(`/crawlseo/api/actions/${actionId}`, { status: "APPROVED" }, "approve")}>
              {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Approve
            </Button>
            <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => call(`/crawlseo/api/actions/${actionId}`, { status: "DISMISSED" }, "dismiss")}>
              <X className="size-4" /> Dismiss
            </Button>
          </>
        )}
        {status === "APPROVED" && (
          <>
            <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => call(`/crawlseo/api/actions/${actionId}/draft`, {}, "draft")}>
              {busy === "draft" ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
              Write draft
            </Button>
            {canAgent && (
              <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => call(`/crawlseo/api/actions/${actionId}/agent-task`, {}, "agent")}>
                {busy === "agent" ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
                Agent task
              </Button>
            )}
          </>
        )}
        {hasDraft && <span className="self-center text-xs text-muted-foreground">Draft linked below</span>}
      </div>
      {notice && <p className="text-xs text-signal">{notice}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
