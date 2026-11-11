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

  it("still prefers a title match when there is one", () => {
    expect(selectReleaseTargetKey(targets, {
      title: "Update the property hero",
      targetUrl: "https://www.susimacdonald.com/riviera-maya-beachfront-sale",
    }, ["src/public/custom-elements/unit-type-collection-split.js"])).toBe("embed:property-hero-v2");
  });

  it("returns null when no changed file belongs to a target", () => {
    expect(selectReleaseTargetKey(targets, { title: "Unrelated", targetUrl: null }, ["src/pages/x.js"])).toBeNull();
  });
});
