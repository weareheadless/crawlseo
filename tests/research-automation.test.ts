import { describe, expect, it } from "vitest";
import { autoAgentDecision } from "@/lib/research/automation";

const base = {
  targetUrl: "https://www.example.com/apartments-for-rent",
  format: "page_update",
  status: "DRAFT_READY",
  hasOpenTask: false,
  hasDelivery: true,
};

describe("research automation", () => {
  it("allows a page on a site with a delivery configuration", () => {
    expect(autoAgentDecision(base)).toEqual({ eligible: true });
  });

  it("allows an article, which publishes through Wix Blog", () => {
    expect(autoAgentDecision({ ...base, format: "article", targetUrl: null })).toEqual({ eligible: true });
  });

  it("allows a technical crawl fix even when the target is a blog URL", () => {
    expect(autoAgentDecision({
      ...base,
      targetUrl: "https://www.example.com/post/can-americans-buy-property-in-mexico",
      source: "crawl_issue",
      kind: "fix_technical_issue",
    })).toEqual({ eligible: true });
  });

  it("does not create a technical task without a mapped target", () => {
    expect(autoAgentDecision({
      ...base,
      targetUrl: null,
      source: "crawl_issue",
      kind: "fix_technical_issue",
    })).toEqual({ eligible: false, reason: "no_target" });
  });

  it("does not create an agent task without a delivery configuration", () => {
    expect(autoAgentDecision({ ...base, hasDelivery: false })).toEqual({ eligible: false, reason: "no_agent_target" });
  });

  it("skips actions that already have an open task", () => {
    expect(autoAgentDecision({ ...base, hasOpenTask: true })).toEqual({ eligible: false, reason: "open_task" });
  });
});
