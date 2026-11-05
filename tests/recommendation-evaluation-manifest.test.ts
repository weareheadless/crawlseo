import { describe, expect, it } from "vitest";

import {
  assertEvaluationExecution,
  parseEvaluationManifest,
  planEvaluation,
} from "@/lib/recommendation/evaluation-manifest";

const manifest = {
  schemaVersion: "recommendation-evaluation-manifest/1" as const,
  approvalReference: "owner-approval-2026-11-04",
  mode: "regression" as const,
  model: "configured-content-model",
  outputDir: "/tmp/opencode/recommendation-evaluation",
  sites: [
    {
      projectId: "p1",
      siteId: "s1",
      domain: "site.test",
      findings: ["f1", "f2"],
    },
  ],
  limits: {
    maxCandidates: 10,
    maxRequests: 24,
    maxRounds: 3,
    maxSpendMicros: 500_000,
  },
};

describe("evaluation manifest", () => {
  it("plans a bounded run without executing it", () => {
    const plan = planEvaluation(parseEvaluationManifest(manifest));
    expect(plan.execute).toBe(false);
    expect(plan.candidateCount).toBe(2);
    expect(plan.sites).toEqual([{ domain: "site.test", candidates: 2 }]);
  });

  it("refuses live execution without the matching owner approval", () => {
    const parsed = parseEvaluationManifest(manifest);
    expect(() => assertEvaluationExecution(parsed, { execute: true })).toThrow(/approval reference/);
    expect(() => assertEvaluationExecution(parsed, { execute: true, approval: "wrong" })).toThrow(/does not match/);
    expect(assertEvaluationExecution(parsed, { execute: true, approval: "owner-approval-2026-11-04" }).execute).toBe(true);
  });

  it("refuses a repository output directory and an over-limit selection", () => {
    expect(() =>
      planEvaluation(parseEvaluationManifest({ ...manifest, outputDir: `${process.cwd()}/eval` }))
    ).toThrow(/outside the repository/);
    expect(() =>
      planEvaluation(parseEvaluationManifest({ ...manifest, limits: { ...manifest.limits, maxCandidates: 1 } }))
    ).toThrow(/above the manifest limit/);
  });
});
