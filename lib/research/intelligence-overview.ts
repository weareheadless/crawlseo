export type IntelligenceCounts = {
  keywords: number;
  actions: number;
  openActions: number;
  actionsWithProvenance: number;
  researchRuns: number;
  keywordRuns: number;
  sources: number;
  observations: number;
  coverage: number;
  unresolvedCoverage: number;
};

export type CountInput = {
  keywords: number;
  actions: Array<{ status: string; evidence: unknown }>;
  researchRuns: number;
  keywordRuns: number;
  sources: number;
  observations: number;
  coverage: Array<{ status: string }>;
};

const CLOSED_ACTIONS = new Set(["DISMISSED", "VERIFIED", "COMPLETE", "COMPLETED", "DONE"]);

/** Provenance is recorded when the Action carries an origin gap or verifier field. */
export function hasRecordedProvenance(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const record = evidence as Record<string, unknown>;
  const origin = record.originGap ?? record.origin_gap;
  const verifier = record.verifier ?? record.verifier_result;
  return Boolean(origin) || Boolean(verifier);
}

export function summarizeIntelligence(input: CountInput): IntelligenceCounts {
  const openActions = input.actions.filter((action) => !CLOSED_ACTIONS.has(action.status)).length;
  return {
    keywords: input.keywords,
    actions: input.actions.length,
    openActions,
    actionsWithProvenance: input.actions.filter((action) => hasRecordedProvenance(action.evidence)).length,
    researchRuns: input.researchRuns,
    keywordRuns: input.keywordRuns,
    sources: input.sources,
    observations: input.observations,
    coverage: input.coverage.length,
    unresolvedCoverage: input.coverage.filter((row) => row.status !== "COVERED").length,
  };
}

export function provenanceNote(counts: IntelligenceCounts): string | null {
  if (counts.actions === 0 || counts.actionsWithProvenance === counts.actions) return null;
  const missing = counts.actions - counts.actionsWithProvenance;
  return `${missing} of ${counts.actions} Actions do not record an origin gap or verifier; that is missing evidence, not a clean result.`;
}
