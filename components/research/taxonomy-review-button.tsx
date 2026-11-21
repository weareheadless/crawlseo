"use client";

import { useState, useTransition } from "react";

import { markTaxonomyReviewedAction } from "@/app/(dashboard)/sites/[siteId]/demand/actions";

/**
 * Acknowledge an automatically approved taxonomy. The map is already in use; this
 * records that a person read it, so the notice stops asking.
 */
export function TaxonomyReviewButton({ siteId }: { siteId: string }) {
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
            try {
              await markTaxonomyReviewedAction(siteId);
              setMessage("Reviewed");
            } catch (error) {
              setMessage(error instanceof Error ? error.message : "Could not save the review");
            }
          })
        }
        className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Mark reviewed"}
      </button>
    </div>
  );
}
