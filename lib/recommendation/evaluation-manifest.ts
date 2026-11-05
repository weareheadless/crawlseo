import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

/**
 * The bounded evaluation manifest.
 *
 * A live evaluation is not a test-suite switch. It names the exact sites, model,
 * destinations, request/round ceilings and spend ceiling, and carries the owner's
 * approval reference. The runner refuses to execute without a matching reference.
 */

export const EvaluationManifestSchema = z.object({
  schemaVersion: z.literal("recommendation-evaluation-manifest/1"),
  approvalReference: z.string().min(1).nullable(),
  mode: z.enum(["regression", "fresh"]),
  model: z.string().min(1),
  outputDir: z.string().min(1),
  sites: z
    .array(
      z.object({
        projectId: z.string().min(1),
        siteId: z.string().min(1),
        domain: z.string().min(1),
        /** Stored finding selectors for Track A; empty for fresh discovery. */
        findings: z.array(z.string().min(1)).default([]),
      })
    )
    .min(1),
  limits: z.object({
    maxCandidates: z.number().int().positive(),
    maxRequests: z.number().int().positive(),
    maxRounds: z.number().int().positive(),
    maxSpendMicros: z.number().int().nonnegative(),
  }),
});

export type EvaluationManifest = z.infer<typeof EvaluationManifestSchema>;

export type EvaluationPlan = {
  mode: EvaluationManifest["mode"];
  model: string;
  sites: Array<{ domain: string; candidates: number }>;
  candidateCount: number;
  outputDir: string;
  execute: boolean;
};

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function parseEvaluationManifest(value: unknown): EvaluationManifest {
  return EvaluationManifestSchema.parse(value);
}

export function planEvaluation(manifest: EvaluationManifest, opts: { execute?: boolean } = {}): EvaluationPlan {
  if (!isAbsolute(manifest.outputDir)) throw new Error("evaluation output directory must be absolute");
  if (inside(process.cwd(), manifest.outputDir)) {
    throw new Error("evaluation output directory must be outside the repository");
  }
  const candidates = manifest.sites.reduce((total, site) => total + site.findings.length, 0);
  if (manifest.mode === "regression" && candidates === 0) {
    throw new Error("regression evaluation needs at least one stored finding selector");
  }
  if (candidates > manifest.limits.maxCandidates) {
    throw new Error(`evaluation selects ${candidates} candidates, above the manifest limit ${manifest.limits.maxCandidates}`);
  }
  return {
    mode: manifest.mode,
    model: manifest.model,
    sites: manifest.sites.map((site) => ({ domain: site.domain, candidates: site.findings.length })),
    candidateCount: candidates,
    outputDir: manifest.outputDir,
    execute: Boolean(opts.execute),
  };
}

/**
 * Gate live execution. The manifest alone is a plan; execution needs both the
 * owner's approval reference in the file and the same reference on the command.
 */
export function assertEvaluationExecution(
  manifest: EvaluationManifest,
  opts: { execute: boolean; approval?: string | null }
): EvaluationPlan {
  const plan = planEvaluation(manifest, { execute: opts.execute });
  if (!opts.execute) return plan;
  if (!manifest.approvalReference) {
    throw new Error("live evaluation needs an approval reference in the manifest");
  }
  if (!opts.approval || opts.approval !== manifest.approvalReference) {
    throw new Error("live evaluation approval reference does not match the manifest");
  }
  return plan;
}
