"use client";

import { useState, useTransition } from "react";

import { refreshFunnelAction } from "@/app/(dashboard)/sites/[siteId]/opportunities/actions";

/**
 * Evidence refresh. Detection is automatic and free: this re-projects stored
 * evidence (crawl results, Search Console) and re-runs the detectors. It makes
 * no paid provider calls, which is why it is safe to expose as a plain button.
 */
export function RefreshFunnelButton({ siteId }: { siteId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            await refreshFunnelAction(siteId);
            setMessage("Refreshed");
          })
        }
        className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:opacity-60"
      >
        {pending ? "Refreshing…" : "Refresh from stored evidence"}
      </button>
    </div>
  );
}
