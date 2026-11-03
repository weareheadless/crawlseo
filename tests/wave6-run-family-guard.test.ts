import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

/**
 * Guard for the one item wave 6 leaves open (docs/ds-02-run-unification.md).
 *
 * The legacy run families still carry job bookkeeping — status, idempotency,
 * caps, parent linkage — so they cannot be dropped until DS-02 moves that onto
 * ResearchRun. This test fails if someone drops them first, and fails if the spec
 * disappears while the tables are still in use.
 */

const schema = readFileSync("prisma/schema.prisma", "utf8");

const LEGACY_RUN_MODELS = ["ArticleKeywordResearchRun", "SeoResearchRun", "SeoResearchTask"];

describe("DS-02 run family guard", () => {
  it("keeps the legacy run models in the schema until the unification lands", () => {
    for (const model of LEGACY_RUN_MODELS) {
      expect(schema, `${model} was removed before DS-02 moved its bookkeeping`).toContain(`model ${model} `);
    }
  });

  it("keeps the spine's run model that they are being unified into", () => {
    expect(schema).toContain("model ResearchRun ");
  });

  it("keeps the specification while the work is open", () => {
    expect(existsSync("docs/ds-02-run-unification.md")).toBe(true);
    const spec = readFileSync("docs/ds-02-run-unification.md", "utf8");
    expect(spec).toContain("Status: **specified, not implemented.**");
    // The order matters: schema, dual-write, read switch, write switch, freeze, drop.
    for (const step of ["Schema only", "Dual-write", "Read switch", "Write switch", "Freeze", "Drop"]) {
      expect(spec).toContain(step);
    }
  });

  it("still reports the families as growing, so the status cannot silently claim completion", async () => {
    const { auditLegacyWriters, scheduledWriters, writersByTable } = await import("../scripts/legacy-writer-audit");
    const findings = await auditLegacyWriters();
    const byTable = writersByTable(await scheduledWriters(findings));
    // While the spec is unimplemented, at least one family must still show a
    // scheduled create; when DS-02 lands, update this test with it.
    const growing = LEGACY_RUN_MODELS.filter((model) =>
      (byTable[model.charAt(0).toLowerCase() + model.slice(1)] ?? []).some((writer) => writer.operation === "create")
    );
    expect(growing.length).toBeGreaterThan(0);
  });
});
