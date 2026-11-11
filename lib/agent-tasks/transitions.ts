export const AGENT_TASK_TRANSITIONS: Record<string, string[]> = {
  READY: ["RUNNING", "CANCELLED"],
  RUNNING: ["AWAITING_REVIEW", "FAILED", "CANCELLED"],
  AWAITING_REVIEW: ["CHANGES_REQUESTED", "APPROVED", "AWAITING_TARGET", "CANCELLED"],
  CHANGES_REQUESTED: ["RUNNING", "APPROVED", "CANCELLED"],
  APPROVED: ["COMMITTED", "CHANGES_REQUESTED", "PUBLISHING", "AWAITING_TARGET"],
  // The route is not live yet, so a route-guarded embed has nowhere to mount.
  // The worker probes the route and resumes when the human creates the page.
  AWAITING_TARGET: ["PUBLISHING", "CHANGES_REQUESTED", "CANCELLED", "FAILED"],
  COMMITTED: ["PUBLISHING", "CLOSED", "CHANGES_REQUESTED"],
  // A locale that is not rendering yet must park the task, not fail it: the
  // packets and mounts are deployed and Wix may still be serving a cached
  // document. The worker re-checks and publishes once the element appears.
  PUBLISHING: ["PUBLISHED", "AWAITING_TARGET", "FAILED"],
  PUBLISHED: ["CLOSED", "CHANGES_REQUESTED"],
  COMPLETED: ["CLOSED"],
  // A failed delivery keeps its reviewed artifact, so returning to review
  // allows a retry without re-running the agent.
  FAILED: ["READY", "AWAITING_REVIEW", "CANCELLED"],
  CANCELLED: [],
  CLOSED: ["CHANGES_REQUESTED"],
};

export function canTransitionAgentTask(from: string, to: string): boolean {
  if (from === to) return true;
  return (AGENT_TASK_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Statuses where telling the agent what to change starts a new run.
 *
 * The note is added to the thread, the task is reopened for a run, and the
 * agent sees the note as a follow-up. A run in flight, a cancellation and a
 * completed task cannot take a follow-up: there is nothing to correct yet, or
 * there is nothing the agent may still change.
 */
const AGENT_FOLLOW_UP_STATUSES = new Set([
  "READY",
  "CHANGES_REQUESTED",
  "AWAITING_REVIEW",
  "AWAITING_TARGET",
  "APPROVED",
  "COMMITTED",
  "PUBLISHED",
  "CLOSED",
  "FAILED",
]);

export function acceptsAgentFollowUp(status: string): boolean {
  return AGENT_FOLLOW_UP_STATUSES.has(status);
}

/** The status a follow-up moves the task to before it can run again. */
export function followUpTargetStatus(status: string): "READY" | "CHANGES_REQUESTED" {
  if (status === "FAILED") return "READY";
  if (status === "READY" || status === "CHANGES_REQUESTED") return status;
  return "CHANGES_REQUESTED";
}
