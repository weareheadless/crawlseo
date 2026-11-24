import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ShareOfVoicePanel } from "@/components/funnel/share-of-voice-panel";
import type { ClusterScoreboard, ClusterShareOfVoice } from "@/lib/funnel/share-of-voice";

/**
 * CMP-008's visible half.
 *
 * The acceptance is specific: a cluster with two weeks and three attributable domains
 * shows four lines (us + three) summing to 100%, with the sample dates; and a cluster
 * with no snapshot shows `unobserved` with **no percentage anywhere on the page**.
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

function sample(over: Partial<ClusterShareOfVoice> = {}): ClusterShareOfVoice {
  return {
    cluster: "achat-lampe-artisanale",
    week: "2026-11-23",
    queriesObserved: 6,
    attributable: 12,
    domains: [
      { domain: "interieurlumiere.com", credit: 0.4, share: 0.4, queries: 4, us: false },
      { domain: "atelier-harmonie.com", credit: 0.3, share: 0.3, queries: 3, us: true },
      { domain: "luminaires.com", credit: 0.2, share: 0.2, queries: 2, us: false },
      { domain: "wecandoo.fr", credit: 0.1, share: 0.1, queries: 1, us: false },
    ],
    ourShare: 0.3,
    ourObserved: true,
    unobserved: false,
    sampledAt: new Date("2026-11-23T00:00:00Z"),
    ...over,
  };
}

function board(over: Partial<ClusterScoreboard> = {}): ClusterScoreboard {
  const latest = sample();
  return {
    cluster: "achat-lampe-artisanale",
    status: {
      status: "contending",
      weeks: ["2026-11-16", "2026-11-23"],
      shares: [0.25, 0.3],
      leaders: ["interieurlumiere.com"],
      reason: "2 of 4 consecutive samples collected; a win needs 4.",
    },
    samples: [sample({ week: "2026-11-16" }), latest],
    latest,
    losing: [
      { query: "luminaire artisanal", domain: "interieurlumiere.com", position: 1 },
      { query: "lampe artisanale", domain: "luminaires.com", position: 2 },
    ],
    unobserved: false,
    ...over,
  };
}

describe("CMP-008 the scoreboard", () => {
  it("shows our line and each competitor's, summing to 100%", () => {
    const text = textOf(ShareOfVoicePanel({ board: board() }));
    expect(text).toContain("atelier-harmonie.com");
    expect(text).toContain("(us)");
    expect(text).toContain("interieurlumiere.com");
    expect(text).toContain("luminaires.com");
    expect(text).toContain("wecandoo.fr");
    // 40 + 30 + 20 + 10 = 100 across the four lines.
    for (const share of ["40%", "30%", "20%", "10%"]) expect(text).toContain(share);
  });

  it("says how many queries each line rests on", () => {
    const text = textOf(ShareOfVoicePanel({ board: board() }));
    expect(text).toContain("4 queries");
    expect(text).toContain("3 queries");
  });

  it("shows the sample week so the number is traceable", () => {
    const text = textOf(ShareOfVoicePanel({ board: board() }));
    expect(text).toContain("week of 2026-11-23");
  });

  it("names the queries we do not hold, and who holds them", () => {
    const text = textOf(ShareOfVoicePanel({ board: board() }));
    expect(text).toContain("Queries we do not hold");
    expect(text).toContain("luminaire artisanal");
    expect(text).toContain("interieurlumiere.com");
    expect(text).toContain("#1");
  });

  it("labels the share as modelled, not observed", () => {
    const text = textOf(ShareOfVoicePanel({ board: board() }));
    expect(text).toContain("position→CTR curve");
    expect(text).toContain("not observed clicks");
  });

  it("shows unobserved with no percentage anywhere", () => {
    const text = textOf(
      ShareOfVoicePanel({
        board: board({
          unobserved: true,
          latest: sample({ unobserved: true, domains: [], ourShare: null, attributable: 0, queriesObserved: 0 }),
          losing: [],
        }),
      })
    );
    expect(text).toContain("unobserved");
    expect(text).toContain("unknown");
    expect(text).toContain("not a zero share");
    // The guard: a percentage in an unobserved panel is the defect this fixes.
    expect(text).not.toMatch(/\d+%/);
  });

  it("shows the status with its reason", () => {
    const text = textOf(ShareOfVoicePanel({ board: board() }));
    expect(text).toContain("contending");
    expect(text).toContain("a win needs 4");
  });

  it("shows a losing status in its own tone", () => {
    const losing = board({
      status: {
        status: "losing",
        weeks: [],
        shares: [],
        leaders: ["interieurlumiere.com"],
        reason: "interieurlumiere.com holds the largest share (40%) in the newest sample.",
      },
    });
    const text = textOf(ShareOfVoicePanel({ board: losing }));
    expect(text).toContain("losing");
    expect(text).toContain("interieurlumiere.com holds the largest share");
  });
});
