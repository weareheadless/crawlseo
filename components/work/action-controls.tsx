"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ActionControls({
  actionId,
  initialStatus,
  hasDraft,
  blogTarget = false,
}: {
  actionId: string;
  initialStatus: string;
  hasDraft: boolean;
  blogTarget?: boolean;
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
        if (label === "approve") {
          if (payload.agentTask?.id) {
            setNotice("Approved. Agent task created — open Implementation below.");
          } else if (payload.agentTaskError === "blog_target") {
            setNotice("Approved. This is an existing Wix Blog post — use the Wix Blog update panel below.");
          } else if (payload.agentTaskError) {
            setNotice(`Approved. No agent task: ${String(payload.agentTaskError).replaceAll("_", " ")}.`);
          } else {
            setNotice("Approved.");
          }
        }
      } else if (label === "draft") {
        const suffix = payload.agentTask?.id
          ? " Agent task created."
          : payload.agentTaskError === "blog_target"
            ? " This is a Wix Blog target, so use the Blog draft path."
            : payload.agentTaskError
              ? ` No agent task: ${String(payload.agentTaskError).replaceAll("_", " ")}.`
              : "";
        setNotice(`Draft ready: ${payload.draft?.title ?? "content draft"}.${suffix}`);
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status === "PROPOSED" && !blogTarget && (
          <>
            <Button size="sm" disabled={Boolean(busy)} onClick={() => call(`/crawlseo/api/actions/${actionId}`, { status: "APPROVED" }, "approve")}>
              {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Approve for implementation
            </Button>
            <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => call(`/crawlseo/api/actions/${actionId}`, { status: "DISMISSED" }, "dismiss")}>
              <X className="size-4" /> Decline proposal
            </Button>
          </>
        )}
        {status === "APPROVED" && !blogTarget && (
          <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => call(`/crawlseo/api/actions/${actionId}/draft`, {}, "draft")}>
            {busy === "draft" ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
            Write draft
          </Button>
        )}
        {hasDraft && <span className="self-center text-xs text-muted-foreground">Draft linked below</span>}
      </div>
      {notice && <p className="text-xs text-signal">{notice}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
