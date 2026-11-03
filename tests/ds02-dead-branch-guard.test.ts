import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The site-scoped SEO research path has no entry point: `requestResearchReport`
 * is the only thing that would enqueue a site-scoped `SEO_RESEARCH` job, and
 * nothing calls it. That is why `seoResearchRun` rows come only from the
 * prelaunch path, and why deleting the site branch is the safe first cutover
 * (docs/ds-02-run-unification.md).
 *
 * This test fails if someone re-wires it without noticing, or deletes the finding
 * from the spec while the branch still exists.
 */
describe("DS-02: the site-scoped SEO research branch is dead", () => {
  const spec = readFileSync("docs/ds-02-run-unification.md", "utf8");

  it("still has no caller for the site-scoped entry point", () => {
    const sources = ["lib/dataforseo/research.ts", "app", "scripts"];
    const files = sources.flatMap((entry) =>
      entry.endsWith(".ts") ? [entry] : []
    );
    const hits = files
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
      .match(/requestResearchReport\(/g);
    // One occurrence is the definition itself.
    expect((hits ?? []).length).toBeLessThanOrEqual(1);
  });

  it("records the finding so the cutover order is justified", () => {
    expect(spec).toContain("The site-scoped SEO research path is dead code");
    expect(spec).toContain("Recommended next cutover: the prelaunch family");
  });
});
