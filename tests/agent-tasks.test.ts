import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "@/lib/agent-tasks/prompt";
import { resolveAgentTarget } from "@/lib/agent-tasks/targets";

describe("agent targets", () => {
  it("resolves the Susi site with and without www", () => {
    expect(resolveAgentTarget("www.susimacdonald.com")?.repoPath).toBe("/home/admin/susimacdonald-wix");
    expect(resolveAgentTarget("susimacdonald.com")?.bridgeSite).toBe("susimacdonald");
  });

  it("does not invent a target for an unknown site", () => {
    expect(resolveAgentTarget("unknown.example")).toBeNull();
  });
});

describe("agent prompt", () => {
  it("includes the action, repo, evidence, and hard delivery guardrails", () => {
    const target = resolveAgentTarget("www.susimacdonald.com");
    if (!target) throw new Error("target missing");
    const prompt = buildAgentPrompt({
      target,
      siteDomain: "www.susimacdonald.com",
      action: {
        title: "Add rental FAQ heading",
        recommendation: "Add a heading above the FAQ section.",
        kind: "add_section",
        format: "page_update",
        targetUrl: "https://www.susimacdonald.com/apartments-for-rent-in-playa",
        primaryQuery: "apartments for rent playa del carmen",
        priority: 70,
        evidence: { source: "gsc", impressions: 500 },
      },
      draft: {
        title: "Rental FAQ",
        markdown: "# Rental FAQ\n\nUpdated copy.",
        metaTitle: "Rental FAQ",
        metaDescription: "A concise FAQ description.",
      },
      operatorInstructions: "Keep the existing design.",
    });

    expect(prompt).toContain("/home/admin/susimacdonald-wix");
    expect(prompt).toContain("Add rental FAQ heading");
    expect(prompt).toContain("apartments for rent playa del carmen");
    expect(prompt).toContain("Work only in the current worktree");
    expect(prompt).toContain("release pipeline handles publication");
    expect(prompt).toContain("Verify sibling routes remain unchanged");
    expect(prompt).toContain("Keep the existing design.");
    expect(prompt).not.toContain("LOCALIZED DATA");
    expect(prompt).not.toContain("BRIDGE PLAN");
  });
});

describe("agent task transitions", () => {
  it("allows the review and delivery workflow", async () => {
    const { canTransitionAgentTask } = await import("@/lib/agent-tasks/transitions");
    expect(canTransitionAgentTask("READY", "RUNNING")).toBe(true);
    expect(canTransitionAgentTask("RUNNING", "AWAITING_REVIEW")).toBe(true);
    expect(canTransitionAgentTask("AWAITING_REVIEW", "CHANGES_REQUESTED")).toBe(true);
    expect(canTransitionAgentTask("CHANGES_REQUESTED", "RUNNING")).toBe(true);
    expect(canTransitionAgentTask("CHANGES_REQUESTED", "APPROVED")).toBe(true);
    expect(canTransitionAgentTask("AWAITING_REVIEW", "APPROVED")).toBe(true);
    expect(canTransitionAgentTask("APPROVED", "COMMITTED")).toBe(true);
    expect(canTransitionAgentTask("COMMITTED", "PUBLISHING")).toBe(true);
    expect(canTransitionAgentTask("PUBLISHING", "PUBLISHED")).toBe(true);
    expect(canTransitionAgentTask("PUBLISHED", "CLOSED")).toBe(true);
    expect(canTransitionAgentTask("PUBLISHED", "CHANGES_REQUESTED")).toBe(true);
    expect(canTransitionAgentTask("CLOSED", "CHANGES_REQUESTED")).toBe(true);
  });

  it("rejects skipped states", async () => {
    const { canTransitionAgentTask } = await import("@/lib/agent-tasks/transitions");
    expect(canTransitionAgentTask("READY", "PUBLISHED")).toBe(false);
    expect(canTransitionAgentTask("CLOSED", "RUNNING")).toBe(false);
  });
});
