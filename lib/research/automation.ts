export type AutoAgentDecision =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "terminal_status"
        | "not_ready"
        | "open_task"
        | "no_target"
        | "no_agent_target";
    };

/**
 * Decide whether a research action can become an agent task without a human
 * having to inspect every prerequisite first.
 *
 * A page or article task needs only the site's delivery configuration: the
 * page route can be assigned before delivery, and an article is published from
 * its draft. A technical fix still needs a mapped target, because it edits the
 * site's code. The task is still reviewed and approved; this only removes the
 * repetitive creation step.
 */
export function autoAgentDecision(input: {
  targetUrl: string | null;
  format: string | null;
  status: string;
  hasOpenTask: boolean;
  hasDelivery: boolean;
  source?: string | null;
  kind?: string | null;
}): AutoAgentDecision {
  if (["DISMISSED", "VERIFIED", "FULFILLED", "FAILED"].includes(input.status)) {
    return { eligible: false, reason: "terminal_status" };
  }
  if (!["PROPOSED", "APPROVED", "DRAFT_READY"].includes(input.status)) {
    return { eligible: false, reason: "not_ready" };
  }
  if (input.hasOpenTask) {
    return { eligible: false, reason: "open_task" };
  }
  if (!input.hasDelivery) {
    return { eligible: false, reason: "no_agent_target" };
  }
  const technical = input.source === "crawl_issue" && input.kind === "fix_technical_issue";
  if (technical && !input.targetUrl) {
    return { eligible: false, reason: "no_target" };
  }
  return { eligible: true };
}
