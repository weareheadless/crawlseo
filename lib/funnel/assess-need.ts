import {
  decideRecommendation,
  type CoverageAssessment,
  type RecommendationDecision,
  type ReviewRequirement,
} from "@/lib/funnel/decision";
import { minimumReview, strongerReview, type NeedAssessment } from "@/lib/research/need-assessment";

/**
 * Build a recommendation decision for a research finding.
 *
 * One implementation, used by the detectors and by the acceptance fixtures, so a
 * test cannot assert a decision the product does not make.
 *
 * The assessment is the only thing that can make a need "supported". A knowledge
 * document that merely exists, a finding that merely asserts the need, or a lexical
 * overlap with a page is not enough: without an assessment the finding stays in the
 * research backlog. This adapter therefore never invents a change, a benefit or a
 * business fit.
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
  /** The persisted, validated assessment of this need, when one was made. */
  assessment?: NeedAssessment | null;
}): RecommendationDecision {
  const reason = input.verificationReason ?? "";
  // The failure can be stated by the verification or by the finding itself: a
  // finding whose theme is "the sources are off-topic" is a pipeline failure even
  // when nothing verified it.
  const sourcesUnusable = /unusable|irrelevant|no evidence|hors sujet|off[- ]topic/i.test(
    `${reason} ${input.label ?? ""} ${input.statement}`
  );
  const review: ReviewRequirement = minimumReview(`${input.statement} ${input.label ?? ""}`);
  const assessment = input.assessment ?? null;

  // A positive page match can contradict the finding's own gap claim even when no
  // verification was recorded. The assessment is proposition-level: it says whether
  // the supplied pages settle the premise, with a quote.
  const assessedContradiction = assessment?.premise.state === "contradicted";
  const contradicted = input.verification === "contradicted" || assessedContradiction;
  const contradictionReason = input.verification === "contradicted"
    ? reason || "the premise is contradicted by the site"
    : assessment?.premise.rationale ?? "the premise is contradicted by the site";

  const legacyCoverage: CoverageAssessment[] =
    input.coverageState && input.coveragePage
      ? [
          {
            pageUrl: input.coveragePage,
            state: input.coverageState as CoverageAssessment["state"],
            method: "lexical",
            matchedTerms: [],
            excerpts: [],
            note: reason || "from research verification",
          },
        ]
      : [];

  const coverage = assessment ? assessment.coverage : legacyCoverage;
  const targetPages = assessment ? assessment.targetPages : [];

  return decideRecommendation({
    need: {
      statement: input.statement,
      audience: null,
      sources: assessment ? assessment.need.evidenceUrls : [],
      observations: input.clusterSize,
      // Only a validated assessment establishes the need. The finding's own
      // assertion is not evidence, and a contradicted premise stays contradicted.
      state: contradicted
        ? "contradicted"
        : assessment
          ? assessment.need.state
          : "unverified",
      sourcesUnusable,
      contradicted,
      contradictionReason: contradicted ? contradictionReason : undefined,
    },
    businessFit: {
      state: contradicted
        ? "unverified"
        : assessment
          ? assessment.offerFit.state
          : input.businessFitState === "contradicted"
            ? "contradicted"
            : "unverified",
      rationale: assessment
        ? assessment.offerFit.rationale
        : input.businessFitState === "contradicted"
          ? input.businessFitRationale ?? "the business should not serve this need"
          : input.businessFit.source === "knowledge"
            ? "business knowledge exists, but it has not been assessed against this need"
            : "business knowledge does not connect this need to an offer",
      basis: assessment
        ? assessment.offerFit.evidenceUrls
        : input.businessFitState === "contradicted"
          ? ["assessment"]
          : [],
    },
    coverage,
    coverageComplete: input.coverageComplete,
    measurement: "unquantified",
    targetPages,
    change: assessment?.change ?? "",
    expectedBenefit: assessment?.expectedBenefit ?? "",
    uncertainty: assessment
      ? assessment.uncertainty
      : [
          "the need has not been assessed against the site's offers and pages",
          "organic demand for this question is not measured",
        ],
    effort: "small",
    review: assessment ? strongerReview(assessment.review, review) : review,
    successMeasure: assessment?.successMeasure ?? "",
    assessment: assessment
      ? {
          model: assessment.model,
          promptVersion: assessment.promptVersion,
          needRationale: assessment.need.rationale,
          needEvidenceUrls: assessment.need.evidenceUrls,
          offerFitRationale: assessment.offerFit.rationale,
          offerFitEvidenceUrls: assessment.offerFit.evidenceUrls,
        }
      : null,
  });
}
