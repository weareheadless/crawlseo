"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WixBlogUpdateControls({
  actionId,
  draftId,
  approved,
  publishedUrl,
  status,
}: {
  actionId: string;
  draftId?: string;
  approved: boolean;
  publishedUrl?: string | null;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState(Boolean(publishedUrl));

  async function call(path: string, label: string, method: "POST" | "PATCH" = "POST", body?: unknown) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `${label} failed`);
      if (label === "publish") setPublished(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  if (published) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-signal">Published to Wix Blog</span>
        {publishedUrl && (
          <a href={publishedUrl} target="_blank" rel="noreferrer noopener" className="text-xs text-primary underline underline-offset-2">
            View live post
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {!draftId ? (
        <>
          <Button
            size="sm"
            onClick={() => call(`/crawlseo/api/actions/${actionId}/wix-blog-draft`, "draft")}
            disabled={Boolean(busy)}
          >
            {busy === "draft" ? <Loader2 className="size-3 animate-spin" /> : <BookOpen className="size-3" />}
            Generate draft
          </Button>
          <span className="text-[11px] text-muted-foreground">Generates the proposal only. Nothing is published.</span>
        </>
      ) : (
        <>
          {!approved ? (
            <>
              <Button size="sm" onClick={() => call(`/crawlseo/api/content-drafts/${draftId}/wix-blog-approve`, "approve")} disabled={Boolean(busy)}>
                {busy === "approve" ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
                Approve exact update
              </Button>
              <span className="text-[11px] text-muted-foreground">Approval is bound to this draft and Action revision. Review the full candidate below first.</span>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => call(`/crawlseo/api/content-drafts/${draftId}/wix-blog-publish`, "publish")} disabled={Boolean(busy)}>
                {busy === "publish" ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
                Publish approved update
              </Button>
              <span className="text-[11px] text-muted-foreground">Publishes only the exact candidate you approved.</span>
            </>
          )}
        </>
      )}
      {status !== "DISMISSED" && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => call(`/crawlseo/api/actions/${actionId}`, "decline", "PATCH", { status: "DISMISSED" })}
          disabled={Boolean(busy)}
        >
          {busy === "decline" ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
          Decline proposal
        </Button>
      )}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}
