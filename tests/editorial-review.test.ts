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

describe("editorial target classes", () => {
  it("moves a product-page action to a durable category landing page", () => {
    const review = deterministicEditorialReview(action({
      title: "Bloc « seconde vie » sur la lampe upcyclée",
      primaryQuery: "lampe upcyclée seconde vie",
      targetUrl: "https://www.atelier-harmonie.com/product-page/lampe-upcyclee-les-singulieres-coquelicot",
      page: {
        ...action().page!,
        url: "https://www.atelier-harmonie.com/product-page/lampe-upcyclee-les-singulieres-coquelicot",
        title: "Lampe upcyclée Les Singulières Coquelicot",
      },
    }), {
      landingPages: [
        { url: "https://www.atelier-harmonie.com/lampes/lampes-upcycling", title: "Créations Upcyclées & Luminaires Uniques" },
        { url: "https://www.atelier-harmonie.com/lampes", title: "Lampes artisanales" },
      ],
    });

    expect(review.decision).toBe("add_section");
    expect(review.targetUrl).toBe("https://www.atelier-harmonie.com/lampes/lampes-upcycling");
    expect(review.targetClass).toBe("category");
    expect(review.originalTargetUrl).toContain("/product-page/");
  });

  it("moves a real-estate listing action to a durable city page", () => {
    const review = deterministicEditorialReview(action({
      title: "Improve listing copy for Tulum",
      primaryQuery: "tulum real estate",
      targetUrl: "https://www.susimacdonald.com/real-estate-listings/example",
      page: {
        ...action().page!,
        url: "https://www.susimacdonald.com/real-estate-listings/example",
        title: "Example Tulum listing",
      },
    }), {
      landingPages: [
        { url: "https://www.susimacdonald.com/tulum-real-estate", title: "Tulum Real Estate" },
        { url: "https://www.susimacdonald.com/homes-for-sale-in-tulum", title: "Homes for Sale in Tulum" },
      ],
    });

    expect(review.decision).toBe("add_section");
    expect(review.targetUrl).toBe("https://www.susimacdonald.com/tulum-real-estate");
    expect(review.targetClass).toBe("landing");
  });

  it("recognizes localized product and category paths", () => {
    const review = deterministicEditorialReview(action({
      title: "Bloc « seconde vie » sur la lampe upcyclée",
      primaryQuery: "lampe upcyclée seconde vie",
      targetUrl: "https://www.atelier-harmonie.com/en/product-page/lampe-upcyclee-les-singulieres-coquelicot",
      page: null,
    }), {
      landingPages: [
        { url: "https://www.atelier-harmonie.com/lampes/lampes-upcycling", title: "Créations Upcyclées & Luminaires Uniques" },
      ],
    });
    expect(review.decision).toBe("add_section");
    expect(review.targetUrl).toBe("https://www.atelier-harmonie.com/lampes/lampes-upcycling");
  });

  it("does not update a product page when no durable target exists", () => {
    const review = deterministicEditorialReview(action({
      primaryQuery: "limited edition lamp",
      targetUrl: "https://www.example.com/product-page/limited-lamp",
      page: null,
      expectedClicks: 0,
    }));
    expect(review.decision).toBe("dismiss");
    expect(review.targetUrl).toBeNull();
    expect(review.targetClass).toBe("unknown");
  });
});
