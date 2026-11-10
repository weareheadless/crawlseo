"use client";

import Link from "next/link";
import { useTransition } from "react";

import {
  attachAgentPlanAction,
  confirmTaskStepAction,
  prepareOpportunityWithAgentAction,
} from "@/app/(dashboard)/sites/[siteId]/opportunities/actions";
import type { TaskStatus } from "@prisma/client";

/**
 * Human execution steps for a task. Every transition records who confirmed it,
 * kept distinct from any agent-prepared artifact (plan decision 3).
 *
 * When an agent delivery task exists, it is the way the work ships: the link
 * opens the page or article review, and the manual "I shipped this" is hidden
 * so a page cannot be marked delivered without the agent's delivery.
 */
export function TaskStepControls({
  siteId,
  opportunityId,
  taskId,
  status,
  agentTaskId = null,
  agentTaskStatus = null,
}: {
  siteId: string;
  opportunityId: string;
  taskId: string;
  status: TaskStatus;
  agentTaskId?: string | null;
  agentTaskStatus?: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<void>) => startTransition(async () => { await fn(); });

  if (status === "verified_outcome") {
    return <p className="text-xs text-[var(--a-success-700)]">Closed: outcome verified.</p>;
  }

  const agentLink = agentTaskId ? (
    <Link
      href={`/sites/${siteId}/agent-tasks/${agentTaskId}`}
      className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-[var(--a-info-800)]"
    >
      Open delivery task
      {agentTaskStatus ? ` · ${agentTaskStatus.toLowerCase().replaceAll("_", " ")}` : ""}
    </Link>
  ) : null;

  const prepare = !agentTaskId ? (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(() => prepareOpportunityWithAgentAction(siteId, opportunityId))}
      className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:opacity-50"
    >
      Prepare with the agent
    </button>
  ) : null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {status === "todo" && (
        <>
          {prepare}
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => confirmTaskStepAction(siteId, opportunityId, taskId, "in_progress"))}
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:opacity-50"
          >
            Start manually
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => attachAgentPlanAction(siteId, opportunityId, taskId))}
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:opacity-50"
          >
            Ask the agent to draft a plan
          </button>
        </>
      )}
      {(status === "in_progress" || status === "awaiting_human") && (
        <>
          {agentLink ?? prepare}
          {!agentTaskId && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => confirmTaskStepAction(siteId, opportunityId, taskId, "delivered"))}
              className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:opacity-50"
            >
              I shipped this manually
            </button>
          )}
          {status === "awaiting_human" && !agentTaskId && (
            <span className="text-[11px] text-[var(--a-warning-700)]">
              An agent prepared this. Review it, then confirm.
            </span>
          )}
        </>
      )}
      {status === "delivered" && (
        <>
          {agentLink}
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => confirmTaskStepAction(siteId, opportunityId, taskId, "verified_outcome"))}
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:border-[var(--a-success-700)]/50 disabled:opacity-50"
          >
            Outcome verified
          </button>
        </>
      )}
    </div>
  );
}
