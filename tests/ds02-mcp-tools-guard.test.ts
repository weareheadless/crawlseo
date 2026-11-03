import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Correction guard (docs/ds-02-run-unification.md).
 *
 * The site-scoped SEO research path is NOT dead: `mcp/project-tools.ts` exposes
 * `requestResearchReport`, `getResearchReportStatus` and `listResearchReports` as
 * project-scoped MCP tools served by the running crawlseo-mcp process. An earlier
 * pass concluded otherwise because it searched only app/, lib/ and scripts/.
 *
 * This test fails if someone deletes those exports on the "dead code" assumption.
 */
describe("DS-02: the site-scoped research path is reachable through MCP", () => {
  const research = readFileSync("lib/dataforseo/research.ts", "utf8");
  const tools = readFileSync("mcp/project-tools.ts", "utf8");

  it("keeps the exports the MCP tools call", () => {
    for (const name of ["requestResearchReport", "getResearchReportStatus", "listResearchReports", "runSeoResearch"]) {
      expect(research, `${name} is called by mcp/project-tools.ts or the job handler`).toContain(name);
    }
  });

  it("keeps them wired in the MCP tool surface", () => {
    for (const name of ["requestResearchReport", "getResearchReportStatus", "listResearchReports"]) {
      expect(tools).toContain(name);
    }
  });

  it("records the correction so the claim is not repeated", () => {
    const spec = readFileSync("docs/ds-02-run-unification.md", "utf8");
    expect(spec).toContain("**Correction (2026-11-03).**");
    expect(spec).toContain("crawlseo-mcp");
    expect(spec).not.toContain("The site-scoped SEO research path is dead code");
  });
});
