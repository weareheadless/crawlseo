"use client";

import { useTransition } from "react";

import {
  acceptOpportunityAction,
  decideOpportunityAction,
} from "@/app/(dashboard)/sites/[siteId]/opportunities/actions";

/**
 * The human decision on an opportunity. Accepting is the only path that
 * creates a task (docs/seo-funnel-spine-plan.md §3).
 */
export function OpportunityDecisionBar({
  siteId,
  opportunityId,
  status,
}: {
  siteId: string;
  opportunityId: string;
  status: string;
}) {
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<void>) => startTransition(async () => { await fn(); });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending || status === "accepted" || status === "in_progress"}
        onClick={() => run(() => acceptOpportunityAction(siteId, opportunityId))}
        className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-[var(--a-info-800)] disabled:opacity-50"
      >
        {pending ? "Working…" : "Accept into a task"}
      </button>
      <button
        type="button"
        disabled={pending || status === "parked"}
        onClick={() => run(() => decideOpportunityAction(siteId, opportunityId, "parked", "parked by owner"))}
        className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-[var(--a-warning-700)]/50 disabled:opacity-50"
      >
        Park
      </button>
      <button
        type="button"
        disabled={pending || status === "rejected"}
        onClick={() => run(() => decideOpportunityAction(siteId, opportunityId, "rejected", "rejected by owner"))}
        className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-muted-foreground transition hover:border-[var(--a-danger-700)]/50 hover:text-foreground disabled:opacity-50"
      >
        Reject
      </button>
      <span className="text-[11px] text-muted-foreground">
        Accepting assigns the task to you. Nothing is published automatically.
      </span>
    </div>
  );
}
