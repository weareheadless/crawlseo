import { describe, expect, it } from "vitest";

import { componentAccepts, extractConfigVariants, rankConfigComponents } from "@/lib/agent-tasks/page-preview";

const page = `
const CONFIG = {"title":"Beachfront","headline":"A","sections":[{"heading":"Condos","paragraphs":["A sentence with a } brace and a \\"quote\\"."]}]};
const CONFIG_ES = {"title":"Frente al mar","headline":"B","sections":[{"heading":"Condominios","paragraphs":["Otra frase."]}]};
const NOT_JSON = {title: "unquoted keys are code, not a literal"};
$w.onReady(() => {
  const ACTIVE = /^\\/es(?:\\/|$)/.test(location.pathname) ? CONFIG_ES : CONFIG;
  views.forEach(v => { v.setAttribute('config', JSON.stringify(ACTIVE)); });
});
`;

/**
 * The review preview used to mount the changed component with no page config
 * and no mode, so it rendered the component's built-in hero and none of the
 * copy the agent had just written.
 */
describe("page config for the preview", () => {
  it("finds every config a page can hand to its element", () => {
    const variants = extractConfigVariants(page);
    expect(variants.map((variant) => variant.name).sort()).toEqual(["CONFIG", "CONFIG_ES"]);
    const spanish = variants.find((variant) => variant.name === "CONFIG_ES");
    expect(spanish?.config).toMatchObject({ title: "Frente al mar", sections: [{ heading: "Condominios" }] });
  });

  it("reads a config written inline", () => {
    const variants = extractConfigVariants(`el.setAttribute("config", JSON.stringify({"title":"Inline","sections":[]}));`);
    expect(variants).toHaveLength(1);
    expect(variants[0].config).toMatchObject({ title: "Inline" });
  });

  it("ignores page files that never set a config", () => {
    expect(extractConfigVariants("const OTHER = {not: 'json'};")).toEqual([]);
  });

  it("only sets attributes the component declares", () => {
    const component = "static get observedAttributes(){return ['config','listings','mode'];}\n";
    expect(componentAccepts(component, "config")).toBe(true);
    expect(componentAccepts(component, "mode")).toBe(true);
    expect(componentAccepts(component, "category-key")).toBe(false);
    expect(componentAccepts("class X {}", "config")).toBe(false);
  });
});

/**
 * The preview used to mount the first three components the directory listed
 * that happened to accept a `config` attribute, which is how a related-listings
 * widget ended up standing in for the page under review.
 */
describe("choosing the component a page config drives", () => {
  const variants = [
    {
      name: "CONFIG",
      config: {
        title: "Condos under $200K",
        headline: "What under $200,000 buys",
        sectionsEyebrow: "Local price bands",
        sectionsHeading: "What under $200K buys",
        sections: [{ heading: "Under $100K" }],
        guides: [{ city: "Tulum" }],
        faq: [{ question: "Can foreigners finance?" }],
      },
    },
  ];
  const observed = (attributes: string[]) =>
    `static get observedAttributes(){return ${JSON.stringify(attributes)};}\n`;

  it("prefers the component that consumes the page's specific keys", () => {
    const ranked = rankConfigComponents([
      { file: "listing-related-v1.js", source: `${observed(["config", "listings"])}const title = "Similar listings";` },
      { file: "property-guide-v2.js", source: `${observed(["config", "brief"])}const title = this.config.title;` },
      {
        file: "unit-type-collection-split.js",
        source: `${observed(["config", "mode"])}const c = this.config; c.sectionsEyebrow, c.sectionsHeading, c.sections, c.guides, c.faq;`,
      },
    ], variants);

    expect(ranked[0].file).toBe("unit-type-collection-split.js");
    expect(ranked[0].score).toBeGreaterThan(2 * ranked[1].score);
  });

  it("ignores components that do not read a config at all", () => {
    const ranked = rankConfigComponents([
      { file: "static-widget.js", source: `${observed(["title"])}const title = "x";` },
    ], variants);
    expect(ranked).toEqual([]);
  });

  it("renders nothing rather than guessing when no key is consumed", () => {
    const ranked = rankConfigComponents([
      { file: "widget.js", source: `${observed(["config"])}const unrelated = 1;` },
    ], [{ name: "CONFIG", config: { onlyThisKey: true } }]);
    expect(ranked).toEqual([]);
  });
});
