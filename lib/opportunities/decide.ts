import type { PrismaClient } from "@prisma/client";

import { acceptOpportunityForSite } from "@/lib/funnel/accept";
import { decideOpportunity } from "@/lib/funnel/opportunity";
import { ExecutionError } from "@/lib/opportunities/external-execution";

/**
 * Accept, park or reject an opportunity, from an executor rather than a browser session.
 *
 * ## Why this is a thin wrapper and not a second implementation
 *
 * The two decisions have different gates and both exist for a reason, so this function
 * routes rather than reimplements:
 *
 * - **accept** goes through `acceptOpportunityForSite`, the single task-creation gate. A
 *   task exists only by accepting an opportunity, and that gate also refuses a legacy row
 *   that was never given an actionable decision.
 * - **park / reject** go through `decideOpportunity`, which records the reason and refuses
 *   a rule that a person would be right to expect: only a `detected` or `parked` row can be
 *   parked or rejected. Active work is not silently abandoned.
 *
 * Writing either of those a second time here would let the two paths drift, and the one that
 * drifted would be the one an agent used.
 *
 * ## Who is recorded
 *
 * `decidedBy` is the person directing the work, not the agent. An agent has no standing to
 * decide what a business should invest in; it executes a decision someone made. Keeping that
 * straight is what lets the audit trail read "Alice accepted it, the session delivered it,
 * here is the commit" instead of attributing a business judgement to a tool.
 */

export type OpportunityDecision = "accept" | "park" | "reject";

export type DecideInput = {
  siteId: string;
  opportunityId: string;
  decision: OpportunityDecision;
  /** The person making the call. A tool cannot decide; it can only carry out a decision. */
  decidedBy: string;
  /** Why, for park and reject. Kept because the next reader's first question is "why not". */
  reason?: string;
  /**
   * The decision version the caller reviewed. When supplied, acceptance refuses a row that
   * changed since, which is what stops a stale board view from becoming a real commitment.
   */
  expectedDecisionId?: string | null;
};

export type DecisionResult = {
  schemaVersion: "1.0";
  projectId: string;
  siteId: string;
  opportunityId: string;
  decision: OpportunityDecision;
  /** The status the row now holds, read back rather than assumed. */
  status: string;
  /** Present for `accept`: the task acceptance created. */
  taskId: string | null;
  decidedBy: string;
};

type DecideDb = Parameters<typeof acceptOpportunityForSite>[0]
  & Pick<PrismaClient, "opportunity">;

export async function decideOpportunityAsExecutor(
  db: DecideDb,
  projectId: string,
  input: DecideInput
): Promise<DecisionResult> {
  const decidedBy = input.decidedBy?.trim();
  if (!decidedBy) {
    throw new ExecutionError(
      "decidedBy is required: record the person who made this call, not the tool that carried it out",
      400
    );
  }

  const opportunity = await db.opportunity.findFirst({
    where: { id: input.opportunityId, projectId },
    select: { id: true, status: true, title: true, updatedAt: true },
  });
  if (!opportunity) throw new ExecutionError("Opportunity not found in this project", 404);

  let taskId: string | null = null;

  if (input.decision === "accept") {
    /**
     * Accepting twice is not an error worth failing on: a client that retries after a network
     * drop should get the same answer, not a 409 that makes it look like the row moved. The
     * gate itself refuses a genuinely wrong row, so the check here only covers the already-
     * accepted case.
     */
    if (opportunity.status === "accepted" || opportunity.status === "in_progress") {
      throw new ExecutionError(
        `opportunity is already ${opportunity.status}; report work against it instead of accepting it again`,
        409
      );
    }
    taskId = await acceptOpportunityForSite(db, {
      siteId: input.siteId,
      opportunityId: opportunity.id,
      assignedTo: decidedBy,
      expectedDecisionId: input.expectedDecisionId ?? null,
    });
  } else {
    const status = input.decision === "park" ? "parked" : "rejected";
    if (!["detected", "parked"].includes(opportunity.status)) {
      throw new ExecutionError(
        `opportunity is ${opportunity.status}; only a detected or parked row can be parked or rejected`,
        409
      );
    }
    await decideOpportunity(db, opportunity.id, status, decidedBy, input.reason, {
      projectId,
      expectedUpdatedAt: opportunity.updatedAt,
    });
  }

  // Read back, so the answer states what is stored rather than what was intended.
  const after = await db.opportunity.findUnique({
    where: { id: opportunity.id },
    select: { status: true },
  });

  return {
    schemaVersion: "1.0",
    projectId,
    siteId: input.siteId,
    opportunityId: opportunity.id,
    decision: input.decision,
    status: after?.status ?? "unknown",
    taskId,
    decidedBy,
  };
}
