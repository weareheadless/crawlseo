import { isWixBlogTarget, resolveAgentTarget } from "@/lib/agent-tasks/targets";

export type AutoAgentDecision =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "terminal_status"
        | "not_ready"
        | "open_task"
        | "article_format"
        | "no_target"
        | "blog_target"
        | "no_agent_target";
    };

/**
 * Decide whether a research action can become an agent task without a human
 * having to inspect every prerequisite first. The task is still reviewed and
 * run manually; this only removes the repetitive creation step.
 */
export function autoAgentDecision(input: {
  targetUrl: string | null;
  format: string | null;
  status: string;
  siteDomain: string;
  hasOpenTask: boolean;
}): AutoAgentDecision {
  if (["DISMISSED", "VERIFIED", "FAILED"].includes(input.status)) {
    return { eligible: false, reason: "terminal_status" };
  }
  if (!["PROPOSED", "APPROVED", "DRAFT_READY"].includes(input.status)) {
    return { eligible: false, reason: "not_ready" };
  }
  if (input.hasOpenTask) {
    return { eligible: false, reason: "open_task" };
  }
  if (input.format === "article") {
    return { eligible: false, reason: "article_format" };
  }
  if (!input.targetUrl) {
    return { eligible: false, reason: "no_target" };
  }
  if (isWixBlogTarget(input.targetUrl)) {
    return { eligible: false, reason: "blog_target" };
  }
  if (!resolveAgentTarget(input.siteDomain)) {
    return { eligible: false, reason: "no_agent_target" };
  }
  return { eligible: true };
}
