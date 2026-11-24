import { describe, expect, it } from "vitest";
import { decideSocialPost, type SocialCopy } from "@/lib/social/eligibility";
import { parseSiteRepresentation } from "@/lib/site/brand";
import type { OpportunityStatus } from "@prisma/client";

const COPY: SocialCopy = {
  subject: "Playa del Carmen",
  kicker: "PLAYA DEL CARMEN",
  headline: "Two streets back from the sand.",
  subline: "What $700,000 buys, and what it does not.",
  caption: "Buyer guidance for Playa del Carmen.",
};

const REPRESENTATION = parseSiteRepresentation({
  serviceArea: { countries: ["MX"], regions: ["Riviera Maya"], places: ["Playa del Carmen", "Tulum"] },
  entries: [],
});

function opportunity(status: OpportunityStatus, decidedBy: string | null = "owner@example.com") {
  return { id: "opp_1", status, decidedBy };
}

const decide = (overrides: Partial<Parameters<typeof decideSocialPost>[0]> = {}) =>
  decideSocialPost({ opportunity: opportunity("delivered"), copy: COPY, ...overrides });

describe("the rule: an actioned opportunity may become one post", () => {
  it("posts for a delivered opportunity a human decided", () => {
    expect(decide()).toMatchObject({ outcome: "post", opportunityId: "opp_1", subject: "Playa del Carmen" });
  });

  it.each<OpportunityStatus>(["accepted", "in_progress", "delivered"])("posts for %s", (status) => {
    expect(decide({ opportunity: opportunity(status) }).outcome).toBe("post");
  });

  it.each<OpportunityStatus>(["detected", "parked", "rejected", "closed"])("rejects %s", (status) => {
    const decision = decide({ opportunity: opportunity(status) });
    expect(decision).toMatchObject({ outcome: "reject", reason: "NOT_ACTIONED" });
  });

  it("rejects a status nobody decided, even when it looks actioned", () => {
    // A detector or a migration can move a row; only a human sets decidedBy.
    const decision = decide({ opportunity: opportunity("in_progress", null) });
    expect(decision).toMatchObject({ outcome: "reject", reason: "NOT_ACTIONED" });
    expect(decision.outcome === "reject" && decision.detail).toContain("without a human decision");
  });
});

describe("once per opportunity", () => {
  it("refuses a second post for the same opportunity", () => {
    const decision = decide({ postedOpportunityIds: new Set(["opp_1"]) });
    expect(decision).toMatchObject({ outcome: "reject", reason: "ALREADY_POSTED" });
  });

  it("is unaffected by another opportunity's post", () => {
    expect(decide({ postedOpportunityIds: new Set(["opp_other"]) }).outcome).toBe("post");
  });
});

describe("copy comes from the brief", () => {
  it("refuses a brief with no copy", () => {
    expect(decide({ copy: null })).toMatchObject({ outcome: "reject", reason: "COPY_UNSUPPORTED" });
    expect(decide({ copy: { headline: "   " } })).toMatchObject({ outcome: "reject", reason: "COPY_UNSUPPORTED" });
  });

  it("refuses a specific the brief has not verified", () => {
    // The Kanai case: $3.8M was inferred, never sourced from the page.
    const decision = decide({ toVerify: ["$3.8 million"], copy: { ...COPY, headline: "From $3.8 million." } });
    expect(decision).toMatchObject({ outcome: "reject", reason: "COPY_UNSUPPORTED" });
    expect(decision.outcome === "reject" && decision.detail).toContain("$3.8 million");
  });

  it("allows the same specific once the brief verifies it", () => {
    expect(decide({ toVerify: [], copy: { ...COPY, headline: "From $3.8 million." } }).outcome).toBe("post");
  });

  it("checks the caption too, not only what is on the image", () => {
    expect(decide({ toVerify: ["49 homes"], copy: { ...COPY, caption: "49 homes, opening 2028." } })).toMatchObject({
      outcome: "reject",
      reason: "COPY_UNSUPPORTED",
    });
  });
});

describe("the subject must be something the brand may promote", () => {
  it("accepts a represented place", () => {
    expect(decide({ representation: REPRESENTATION, copy: { ...COPY, subject: "Tulum" } }).outcome).toBe("post");
  });

  it("refuses a project the brand does not represent", () => {
    // The proof promoted Mandarin Oriental Kanai; the brand had no standing to.
    const decision = decide({ representation: REPRESENTATION, copy: { ...COPY, subject: "Mandarin Oriental Kanai" } });
    expect(decision).toMatchObject({ outcome: "reject", reason: "COPY_UNSUPPORTED" });
    expect(decision.outcome === "reject" && decision.detail).toContain("does not represent");
  });

  it("refuses every subject when nothing is recorded", () => {
    const empty = parseSiteRepresentation(null);
    expect(decide({ representation: empty, copy: { ...COPY, subject: "Playa del Carmen" } }).outcome).toBe("reject");
  });

  it("does not check the subject when representation is not supplied", () => {
    expect(decide({ copy: { ...COPY, subject: "Somewhere Unlisted" } }).outcome).toBe("post");
  });
});
