import { describe, expect, it } from "vitest";

import { isValidElement, type ReactElement } from "react";

import { LinkTargetPanel } from "@/components/funnel/link-target-panel";
import type { LinkTarget } from "@/lib/funnel/backlink-gap";

/**
 * CMP-007's visible half.
 *
 * The acceptance says a person must be able to execute the link play without
 * opening Ahrefs, so the panel has to show the domains themselves, not a count.
 * These tests pin the three claims the panel makes and the one it must not:
 *  - the targets are listed with their provider rank,
 *  - the excluded shared domains are stated, so the gap is not overstated,
 *  - a competitor with no data is named rather than presented as "no gap",
 *  - and nothing in the copy implies an automated campaign.
 */

type Node = ReactElement<Record<string, unknown>>;

function textOf(node: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isValidElement(value)) return;
    visit((value as Node).props.children);
  };
  visit(node);
  return parts.join(" ");
}

const target = (domain: string, rank: number | null, competitorsLinking = 1, over: Partial<LinkTarget> = {}): LinkTarget => ({
  domain,
  rank,
  backlinks: null,
  targetUrl: null,
  linkType: null,
  competitorsLinking,
  ...over,
});

describe("CMP-007 the link-target panel", () => {
  it("lists the target domains with their provider rank", () => {
    const text = textOf(
      LinkTargetPanel({
        targets: [target("wecandoo.be", 407), target("programme-television.org", 367), target("atelier-initiation.fr", 321)],
        sharedCount: 54,
        competitorCount: 3,
        missing: [],
        ourDomainCount: 63,
      })
    );
    expect(text).toContain("wecandoo.be");
    expect(text).toContain("407");
    expect(text).toContain("programme-television.org");
    expect(text).toContain("atelier-initiation.fr");
  });

  it("states the excluded shared domains so the gap is not overstated", () => {
    const text = textOf(
      LinkTargetPanel({ targets: [target("a.com", 10)], sharedCount: 54, competitorCount: 3, missing: [], ourDomainCount: 63 })
    );
    expect(text).toContain("54");
    expect(text).toContain("were excluded");
  });

  it("says how many competitors were measured", () => {
    const text = textOf(
      LinkTargetPanel({ targets: [target("a.com", 10)], sharedCount: 0, competitorCount: 3, missing: [], ourDomainCount: 63 })
    );
    expect(text).toContain("3 competitors compared");
  });

  it("says there is no gap when every competitor domain is shared", () => {
    const text = textOf(
      LinkTargetPanel({ targets: [], sharedCount: 42, competitorCount: 2, missing: [], ourDomainCount: 63 })
    );
    expect(text).toContain("No link gap");
    expect(text).toContain("also links to us");
  });

  it("names a competitor with no data rather than showing an empty table", () => {
    const text = textOf(
      LinkTargetPanel({ targets: [], sharedCount: 0, competitorCount: 1, missing: ["silent.com"], ourDomainCount: 63 })
    );
    expect(text).toContain("not measured");
    expect(text).toContain("silent.com");
  });

  it("says an unmeasured own profile has no count, instead of claiming zero", () => {
    const text = textOf(
      LinkTargetPanel({ targets: [target("a.com", 10)], sharedCount: 0, competitorCount: 1, missing: [], ourDomainCount: null })
    );
    // No fabricated "0 referring domains": an unknown subtrahend is stated as absent.
    expect(text).not.toContain("0 referring domain");
  });

  it("does not imply an automated outreach campaign", () => {
    const text = textOf(
      LinkTargetPanel({ targets: [target("a.com", 10)], sharedCount: 0, competitorCount: 1, missing: [], ourDomainCount: 63 })
    );
    expect(text).toContain("not a campaign");
    expect(text).toContain("nothing here sends an email");
  });

  it("counts how many competitors a single domain links to", () => {
    const text = textOf(
      LinkTargetPanel({ targets: [target("both.com", 90, 2)], sharedCount: 0, competitorCount: 2, missing: [], ourDomainCount: 63 })
    );
    expect(text).toContain("2 competitors");
  });
});
