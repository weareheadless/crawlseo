"use client";

import { useState, useTransition } from "react";

import { declareAllTrackedGridsAction, declareTrackedGridAction } from "@/app/(dashboard)/sites/[siteId]/demand/actions";

/**
 * CMP-004's declaration control.
 *
 * "Track" is a decision, so it is a button and not a side effect of loading a
 * page. It writes the flag on the cluster's memberships; it buys nothing.
 */
export function DeclareGridButton({
  siteId,
  clusterSlug,
  tracked,
}: {
  siteId: string;
  clusterSlug: string;
  /** Already-tracked queries, when the cluster has a grid. */
  tracked: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {message && <span className="text-[11px] text-muted-foreground">{message}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const result = await declareTrackedGridAction(siteId, clusterSlug);
            if (!result.ok) {
              setMessage(result.error);
              return;
            }
            setMessage(
              result.tracked.length === 0
                ? "This cluster has no members to track yet."
                : `Tracking ${result.tracked.length} ${result.tracked.length === 1 ? "query" : "queries"}.`
            );
          })
        }
        className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-2.5 text-[11px] font-medium text-foreground transition hover:border-primary/40 disabled:opacity-60"
      >
        {pending ? "Declaring…" : tracked.length > 0 ? "Re-declare grid" : "Track this cluster"}
      </button>
    </div>
  );
}

export function DeclareAllGridsButton({ siteId }: { siteId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {message && <span className="text-[11px] text-muted-foreground">{message}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const result = await declareAllTrackedGridsAction(siteId);
            if (!result.ok) {
              setMessage(result.error);
              return;
            }
            setMessage(
              `${result.declared} ${result.declared === 1 ? "cluster" : "clusters"} now tracked on ${result.queries} queries` +
                (result.empty > 0 ? ` · ${result.empty} had no members` : "")
            );
          })
        }
        className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:opacity-60"
      >
        {pending ? "Declaring…" : "Declare every cluster's grid"}
      </button>
    </div>
  );
}
