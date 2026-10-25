import { describe, expect, it } from "vitest";
import { contentEmbedTags, presentContentTags } from "@/lib/delivery/preflight";

describe("target preflight", () => {
  const targets = [
    { componentTag: "atelier-navbar-v1" },
    { componentTag: "atelier-footer-v1" },
    { componentTag: "atelier-lamp-category-v1" },
    { componentTag: "atelier-lamps-v1" },
  ];

  it("excludes global chrome from content embed tags", () => {
    expect(contentEmbedTags(targets)).toEqual(["atelier-lamp-category-v1", "atelier-lamps-v1"]);
  });

  it("requires an actual content custom element, not a script string", () => {
    const html = "<atelier-navbar-v1></atelier-navbar-v1><atelier-footer-v1></atelier-footer-v1><script>atelier-lamp-category-v1</script>";
    expect(presentContentTags(html, contentEmbedTags(targets))).toEqual([]);
  });

  it("accepts a page with a content custom element", () => {
    const html = "<atelier-navbar-v1></atelier-navbar-v1><atelier-lamp-category-v1></atelier-lamp-category-v1>";
    expect(presentContentTags(html, contentEmbedTags(targets))).toEqual(["atelier-lamp-category-v1"]);
  });
});
