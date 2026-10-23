"use client";

import { useState } from "react";
import { BookOpen, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WixBlogDraftButton({ draftId, existingExternalId }: { draftId: string; existingExternalId?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [externalId, setExternalId] = useState(existingExternalId ?? null);
  const [error, setError] = useState<string | null>(null);

  async function createDraft() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/crawlseo/api/content-drafts/${draftId}/wix-blog-draft`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not create Wix Blog draft");
      setExternalId(payload.delivery?.externalId ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create Wix Blog draft");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button variant="outline" size="xs" onClick={createDraft} disabled={busy || Boolean(externalId)}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : externalId ? <Check className="size-3 text-signal" /> : <BookOpen className="size-3" />}
        {externalId ? "Wix Blog draft created" : "Create Wix Blog draft"}
      </Button>
      {externalId && <span className="font-data text-[10px] text-muted-foreground">draft {externalId}</span>}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}
