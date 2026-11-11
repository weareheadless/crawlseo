import { describe, expect, it } from "vitest";
import { scoreEmbedTarget, selectEmbedTargetKey, selectReleaseTargetKey } from "@/lib/delivery/target-selection";

const atelierTargets = [
  { key: "embed:atelier-about-v1", componentTag: "atelier-about-v1" },
  { key: "embed:atelier-lamp-category-v1", componentTag: "atelier-lamp-category-v1" },
  { key: "embed:atelier-lamps-v1", componentTag: "atelier-lamps-v1" },
  { key: "embed:atelier-product-v1", componentTag: "atelier-product-v1" },
  { key: "embed:atelier-product-faq-v1", componentTag: "atelier-product-faq-v1" },
];

describe("embed target selection", () => {
  it("selects the category component for an Atelier category URL", () => {
    const action = {
      title: "Add a focused section to “Upcycled creations & unique lighting | Atelier Harmonie”",
      targetUrl: "https://www.atelier-harmonie.com/lampes/lampes-upcycling",
    };
    expect(selectEmbedTargetKey(atelierTargets, action)).toBe("embed:atelier-lamp-category-v1");
    const categoryScore = scoreEmbedTarget(atelierTargets[1], action);
    const productScore = scoreEmbedTarget(atelierTargets[3], action);
    expect(categoryScore).toBeGreaterThan(productScore);
  });

  it("returns null when two targets tie", () => {
    expect(selectEmbedTargetKey([
      { key: "embed:a", componentTag: "atelier-about-v1" },
      { key: "embed:b", componentTag: "atelier-contact-v1" },
    ], {
      title: "Atelier",
      targetUrl: "https://www.atelier-harmonie.com/",
    })).toBeNull();
  });
});

describe("release target from the changed file", () => {
  const targets = [
    { key: "embed:unit-type-collection-split", componentTag: "unit-type-collection-split", sourcePath: "src/public/custom-elements/unit-type-collection-split.js" },
    { key: "embed:property-hero-v2", componentTag: "property-hero-v2", sourcePath: "src/public/custom-elements/property-hero-v2.js" },
    { key: "embed:playa-city-properties-hero", componentTag: "playa-city-properties-hero", sourcePath: "src/public/custom-elements/playa-city-properties-hero.js" },
  ];

  it("uses the component the task changed when the title names no target", () => {
    // The action describes the page, not the component that renders it.
    expect(selectReleaseTargetKey(targets, {
      title: "Expand the thin Riviera Maya beachfront page for Playa condo searches",
      targetUrl: "https://www.susimacdonald.com/riviera-maya-beachfront-sale",
    }, [
      "src/pages/Riviera Maya Beachfront For Sale.hlceo.js",
      "src/public/custom-elements/unit-type-collection-split.js",
    ])).toBe("embed:unit-type-collection-split");
  });

  it("does not let a page word in the title outrank the changed component", () => {
    // Regression: "Playa" in the title matched the unrelated Playa hero, so
    // the release updated that embed and never rebuilt the units packet.
    expect(selectReleaseTargetKey(targets, {
      title: "Improve the Playa beachfront page",
      targetUrl: "https://www.susimacdonald.com/riviera-maya-beachfront-sale",
    }, ["src/public/custom-elements/unit-type-collection-split.js"])).toBe("embed:unit-type-collection-split");
  });

  it("falls back to the title only when no changed file belongs to a target", () => {
    expect(selectReleaseTargetKey(targets, {
      title: "Update the property hero",
      targetUrl: "https://www.susimacdonald.com/riviera-maya-beachfront-sale",
    }, ["src/pages/x.js"])).toBe("embed:property-hero-v2");
  });

  it("returns null when no changed file belongs to a target and the title is ambiguous", () => {
    expect(selectReleaseTargetKey(targets, { title: "Unrelated", targetUrl: null }, ["src/pages/x.js"])).toBeNull();
  });

  it("returns null when several components changed and the title does not decide", () => {
    expect(selectReleaseTargetKey(targets, {
      title: "Update the page",
      targetUrl: "https://www.susimacdonald.com/riviera-maya-beachfront-sale",
    }, [
      "src/public/custom-elements/unit-type-collection-split.js",
      "src/public/custom-elements/playa-city-properties-hero.js",
    ])).toBeNull();
  });

  it("compares Windows-style paths with the target source", () => {
    expect(selectReleaseTargetKey(targets, { title: "Playa page", targetUrl: null }, [
      "src\\public\\custom-elements\\unit-type-collection-split.js",
    ])).toBe("embed:unit-type-collection-split");
  });
});
