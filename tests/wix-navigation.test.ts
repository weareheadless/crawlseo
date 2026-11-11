import { describe, expect, it } from "vitest";

import { applyNavigationPlan, parseNavigationPlan } from "@/lib/delivery/wix-navigation";

const plan = {
  target: "src/public/custom-elements/site-navbar-v1.js",
  component: "navbar",
  summary: "Add a link",
  edits: [
    {
      find: '<a href="/a">A</a><a href="/b">B</a>',
      replace: '<a href="/a">A</a><a href="/new">New</a><a href="/b">B</a>',
    },
  ],
};

describe("navigation plan", () => {
  it("applies an exact edit once", () => {
    const source = 'const html = \'<a href="/a">A</a><a href="/b">B</a>\';';
    expect(applyNavigationPlan(source, plan)).toContain('<a href="/new">New</a>');
  });

  it("treats a retry after a successful apply as done, not as a failure", () => {
    const source = 'const html = \'<a href="/a">A</a><a href="/new">New</a><a href="/b">B</a>\';';
    expect(applyNavigationPlan(source, plan)).toBe(source);
  });

  it("does not append a second copy when the find string is a prefix of the replacement", () => {
    const prefixPlan = {
      ...plan,
      edits: [
        { find: '{"a":1}', replace: '{"a":1,"b":2}' },
        { find: '"a":1', replace: '"a":1,"b":2' },
      ],
    };
    const source = 'const dict = {"a":1,"b":2};';
    expect(applyNavigationPlan(source, prefixPlan)).toBe(source);
  });

  it("refuses a find string that matches nothing and is not already applied", () => {
    expect(() => applyNavigationPlan('const html = "nothing here";', plan)).toThrow(/matches 0 places/);
  });

  it("refuses an ambiguous find string", () => {
    const source = 'const a = \'<a href="/a">A</a><a href="/b">B</a>\'; const b = \'<a href="/a">A</a><a href="/b">B</a>\';';
    expect(() => applyNavigationPlan(source, plan)).toThrow(/matches 2 places/);
  });

  it("refuses an edit that would not parse as JavaScript", () => {
    const broken = { ...plan, edits: [{ find: "<a", replace: "<a " }] };
    expect(() => applyNavigationPlan('const html = "<a>";', broken)).not.toThrow();
    const syntax = { ...plan, edits: [{ find: 'const html = "<a>";', replace: "const html = <a>;" }] };
    expect(() => applyNavigationPlan('const html = "<a>";', syntax)).toThrow();
  });

  it("parses a plan and drops empty edits", () => {
    const parsed = parseNavigationPlan(JSON.parse(JSON.stringify(plan)));
    expect(parsed?.edits).toHaveLength(1);
    expect(parseNavigationPlan({ target: "x", component: "y", edits: [{ find: "a", replace: "a" }] })).toBeNull();
    expect(parseNavigationPlan({ target: "", component: "y", edits: plan.edits })).toBeNull();
  });
});
