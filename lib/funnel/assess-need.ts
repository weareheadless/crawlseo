import {
  decideRecommendation,
  type CoverageAssessment,
  type RecommendationDecision,
  type ReviewRequirement,
} from "@/lib/funnel/decision";

/**
 * Build a recommendation decision for a research finding.
 *
 * One implementation, used by the detectors and by the acceptance fixtures, so a
 * test cannot assert a decision the product does not make.
 */
export function assessCustomerNeed(input: {
  statement: string;
  /** The finding's short label; a "sources are off-topic" label is itself the failure. */
  label?: string;
  clusterSize: number;
  /** How the claim was verified, when it was. */
  verification: string | null;
  verificationReason: string | null;
  coverageState: string | null;
  coveragePage: string | null;
  coverageComplete: boolean;
  businessFit: { value: number; source: "knowledge" | "unknown" };
  /** Business fit can be contradicted (the business should not serve the need). */
  businessFitState?: "supported" | "unverified" | "contradicted";
  businessFitRationale?: string;
  kind: "need" | "offer";
}): RecommendationDecision {
  const contradicted = input.verification === "contradicted";
  const reason = input.verificationReason ?? "";
  // The failure can be stated by the verification or by the finding itself: a
  // finding whose theme is "the sources are off-topic" is a pipeline failure even
  // when nothing verified it.
  const sourcesUnusable = /unusable|irrelevant|no evidence|hors sujet|off[- ]topic/i.test(`${reason} ${input.label ?? ""} ${input.statement}`);
  const coverage: CoverageAssessment[] = input.coverageState && input.coveragePage
    ? [{
        pageUrl: input.coveragePage,
        state: input.coverageState as CoverageAssessment["state"],
        method: "lexical",
        matchedTerms: [],
        excerpts: [],
        note: reason || "from research verification",
      }]
    : [];
  const review: ReviewRequirement = /legal|medical|safety|juridique|juridico|sécurité|salud/i.test(input.statement)
    ? "subject_matter_expert"
    : "none";
  const targetPages = coverage.map((row) => row.pageUrl);
  return decideRecommendation({
    need: {
      statement: input.statement,
      audience: null,
      sources: [],
      observations: input.clusterSize,
      sourcesUnusable,
      contradicted,
      contradictionReason: contradicted ? reason : undefined,
    },
    businessFit: {
      state: input.businessFitState
        ?? (input.businessFit.source === "knowledge" ? "supported" : "unverified"),
      rationale: input.businessFitRationale
        ?? (input.businessFit.source === "knowledge"
          ? "the business knowledge names an offer this need relates to"
          : "business knowledge does not yet connect this need to an offer"),
      basis: input.businessFit.source === "knowledge" ? ["business knowledge"] : [],
    },
    coverage,
    coverageComplete: input.coverageComplete,
    measurement: "unquantified",
    targetPages,
    change: targetPages.length > 0
      ? `Update ${targetPages[0]} so it answers: ${input.statement.slice(0, 200)}`
      : `Add an answer that covers: ${input.statement.slice(0, 200)}`,
    expectedBenefit: input.kind === "need"
      ? "Customers get a direct answer where the site currently leaves them to infer it"
      : "The offer is stated where customers compare alternatives",
    uncertainty: ["organic demand for this question is not measured"],
    effort: "small",
    review,
    successMeasure: "the page answers the question in an owner review",
  });
}
