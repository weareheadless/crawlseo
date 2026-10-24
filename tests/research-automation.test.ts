import { describe, expect, it } from "vitest";
import { autoAgentDecision } from "@/lib/research/automation";

describe("research automation", () => {
  it("allows a non-blog page on a site with an agent target", () => {
    expect(autoAgentDecision({
      targetUrl: "https://www.susimacdonald.com/apartments-for-rent-in-playa",
      format: "page_update",
      status: "DRAFT_READY",
      siteDomain: "www.susimacdonald.com",
      hasOpenTask: false,
    })).toEqual({ eligible: true });
  });

  it("does not create agent tasks for Wix Blog posts", () => {
    expect(autoAgentDecision({
      targetUrl: "https://www.susimacdonald.com/post/can-americans-buy-property-in-mexico",
      format: "page_update",
      status: "DRAFT_READY",
      siteDomain: "www.susimacdonald.com",
      hasOpenTask: false,
    })).toEqual({ eligible: false, reason: "blog_target" });
  });

  it("does not create an agent task without a configured site target", () => {
    expect(autoAgentDecision({
      targetUrl: "https://www.atelier-harmonie.com/",
      format: "page_update",
      status: "DRAFT_READY",
      siteDomain: "unknown.example",
      hasOpenTask: false,
    })).toEqual({ eligible: false, reason: "no_agent_target" });
  });

  it("skips actions that already have an open task", () => {
    expect(autoAgentDecision({
      targetUrl: "https://www.susimacdonald.com/apartments-for-rent-in-playa",
      format: "page_update",
      status: "APPROVED",
      siteDomain: "www.susimacdonald.com",
      hasOpenTask: true,
    })).toEqual({ eligible: false, reason: "open_task" });
  });
});
