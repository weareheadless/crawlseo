import { describe, expect, it } from "vitest";

import { componentAccepts, extractConfigVariants } from "@/lib/agent-tasks/page-preview";

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
