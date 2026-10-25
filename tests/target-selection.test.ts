import { describe, expect, it } from "vitest";
import { scoreEmbedTarget, selectEmbedTargetKey } from "@/lib/delivery/target-selection";

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
