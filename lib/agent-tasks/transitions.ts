export const AGENT_TASK_TRANSITIONS: Record<string, string[]> = {
  READY: ["RUNNING", "CANCELLED"],
  RUNNING: ["AWAITING_REVIEW", "FAILED", "CANCELLED"],
  AWAITING_REVIEW: ["CHANGES_REQUESTED", "APPROVED"],
  CHANGES_REQUESTED: ["RUNNING", "CANCELLED"],
  APPROVED: ["COMMITTED", "CHANGES_REQUESTED"],
  COMMITTED: ["PUBLISHING", "CLOSED"],
  PUBLISHING: ["PUBLISHED", "FAILED"],
  PUBLISHED: ["CLOSED"],
  COMPLETED: ["CLOSED"],
  FAILED: ["READY", "CANCELLED"],
  CANCELLED: [],
  CLOSED: [],
};

export function canTransitionAgentTask(from: string, to: string): boolean {
  if (from === to) return true;
  return (AGENT_TASK_TRANSITIONS[from] ?? []).includes(to);
}
