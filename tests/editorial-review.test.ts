import { describe, expect, it } from "vitest";
import type { ContentAction } from "@/lib/ai-seo/action-plan";
import {
  deterministicEditorialReview,
  editorialFingerprint,
} from "@/lib/editorial/review";

function action(overrides: Partial<ContentAction> = {}): ContentAction {
  return {
    id: "action-1",
    kind: "improve_page",
    format: "page_update",
    title: "Strengthen the page for “hospital near me”",
    primaryQuery: "hospital near me",
    targetUrl: "https://www.example.com/post/top-hospitals",
    intent: "local",
    signals: ["striking_distance"],
    evidence: {},
    page: {
      url: "https://www.example.com/post/top-hospitals",
      title: "Top Hospitals in Cancun and Riviera Maya",
      description: "A guide to the leading hospitals in the region.",
      wordCount: 1000,
      contentScore: 90,
      h1Count: 1,
      statusCode: 200,
    },
    impact: 70,
    confidence: 80,
    effort: 38,
    score: 70,
    expectedClicks: 152,
    recommendedAction: "Strengthen the page.",
    ...overrides,
  };
}

describe("editorial review", () => {
  it("turns a local near-me query into a scoped section", () => {
    const review = deterministicEditorialReview(action());
    expect(review.decision).toBe("add_section");
    expect(review.title).toContain("Add a nearby-care section");
    expect(review.scope).toContain("not a rewrite");
  });

  it("keeps a strong page match as a page update", () => {
    const review = deterministicEditorialReview(action({
      title: "Strengthen “Tulum Real Estate”",
      primaryQuery: "tulum real estate",
      page: {
        ...action().page!,
        title: "Tulum Real Estate Guide",
        description: "Homes and investment guidance in Tulum.",
      },
    }));
    expect(review.decision).toBe("update_page");
    expect(review.pageFit).toBe("strong");
  });

  it("creates a new article when the mapped page does not fit", () => {
    const review = deterministicEditorialReview(action({
      title: "Strengthen the page for “dental implants”",
      primaryQuery: "dental implants",
      intent: "commercial",
      page: {
        ...action().page!,
        title: "Top Hospitals in Cancun",
        description: "Hospital guide.",
      },
    }));
    expect(review.decision).toBe("new_article");
    expect(review.pageFit).toBe("none");
  });

  it("dismisses a weak mismatch with no meaningful upside", () => {
    const review = deterministicEditorialReview(action({
      primaryQuery: "dental implants",
      targetUrl: null,
      page: null,
      expectedClicks: 1,
    }));
    expect(review.decision).toBe("dismiss");
  });

  it("fingerprints the candidate inputs", () => {
    expect(editorialFingerprint(action())).toBe(editorialFingerprint(action()));
    expect(editorialFingerprint(action())).not.toBe(editorialFingerprint(action({ expectedClicks: 5 })));
  });
});
