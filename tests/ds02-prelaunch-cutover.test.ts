import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  buildPrelaunchReport,
  prelaunchRunStatus,
  reportEntries,
  type PrelaunchReportEntry,
} from "@/lib/dataforseo/prelaunch-runner";

const entry = (over: Partial<PrelaunchReportEntry> = {}): PrelaunchReportEntry => ({
  operation_key: "keyword:1:freediving:en:MX",
  kind: "keyword_seed",
  status: "completed",
  result: [{ keyword: "freediving", volume: 10 }],
  cost_micros: 62400,
  error_code: null,
  seed: "freediving",
  ...over,
});

describe("prelaunch report entries", () => {
  it("reads the entries the runner writes, ignoring malformed rows", () => {
    const entries = reportEntries({
      dataforseo: [entry(), { status: "completed" }, entry({ operation_key: "keyword:2:cenote:en:MX" })],
    });
    expect(entries.map((e) => e.operation_key)).toEqual([
      "keyword:1:freediving:en:MX",
      "keyword:2:cenote:en:MX",
    ]);
  });

  it("treats a missing report as no results rather than as success", () => {
    expect(reportEntries(null)).toEqual([]);
    expect(reportEntries({ skipped: [] })).toEqual([]);
  });

  it("marks a run complete only when every planned call completed", () => {
    expect(prelaunchRunStatus([entry(), entry({ operation_key: "k2" })], 2)).toBe("COMPLETED");
    expect(prelaunchRunStatus([entry()], 2)).toBe("PARTIAL");
    expect(prelaunchRunStatus([entry({ status: "failed", cost_micros: null })], 2)).toBe("PARTIAL");
    expect(prelaunchRunStatus([], 2)).toBe("FAILED");
  });

  it("keeps the report shape the page and evidence bridge already read", () => {
    const report = buildPrelaunchReport("2026-10", [entry()]);
    expect(report).toMatchObject({ schema_version: 1, period: "2026-10", domainless: true });
    expect(Array.isArray(report.skipped)).toBe(true);
  });
});

describe("DS-02 prelaunch cutover is real, not partial", () => {
  const prelaunch = readFileSync("lib/dataforseo/prelaunch.ts", "utf8");
  const runner = readFileSync("lib/dataforseo/prelaunch-runner.ts", "utf8");
  const report = readFileSync("lib/dataforseo/prelaunch-report.ts", "utf8");

  it("request and runner write the unified run and no legacy table", () => {
    expect(prelaunch).toContain("researchRun.create");
    expect(prelaunch).not.toContain("seoResearchRun.create");
    expect(runner).not.toContain("seoResearchRun");
    expect(runner).not.toContain("seoResearchTask");
    expect(report).not.toContain("seoResearchRun");
  });

  it("keeps the task plan and results in the run, not in task rows", () => {
    expect(prelaunch).toContain("tasks,");
    expect(runner).toContain("report: buildPrelaunchReport");
  });
});
