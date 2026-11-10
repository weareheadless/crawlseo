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
  PUBLISHING: ["PUBLISHED", "FAILED"],
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
