/**
 * Recommendation decision contract (execution brief §2).
 *
 * The funnel used to decide "is this an opportunity?" with one number: a priority
 * index that needed demand evidence. That conflated four separate questions and
 * produced three failure modes the expert review found:
 *
 *  - a customer need with no keyword volume was demoted to a hypothesis, so a real
 *    problem was never proposed;
 *  - a contradicted premise stayed on the board as a low-scoring hypothesis;
 *  - research-quality failures ("the sources are irrelevant", "there is no
 *    evidence") were published as customer needs.
 *
 * This module answers the four questions separately and decides readiness from
 * them. It is pure: detectors, reassessment, views and task acceptance all call the
 * same function, so a recommendation cannot mean one thing in the API and another
 * on the board.
 */

export type EvidenceState = "supported" | "unverified" | "contradicted";

export type Readiness = "actionable" | "needs_investigation" | "research_backlog" | "rejected";

/** What kind of value the work produces. Tracks are not added together. */
export type BenefitTrack = "customer_value" | "organic_growth" | "technical_health";

/**
 * How the benefit is known.
 *
 * `observed_baseline` — we measured the current state (impressions, clicks, a
 *   verified defect). The *future* benefit is still a forecast.
 * `forecast` — a scenario derived from an observed baseline or market volume.
 * `unquantified` — the benefit is real but not measured, e.g. a clearer answer to a
 *   question customers already ask.
 */
export type BenefitMeasurement = "observed_baseline" | "forecast" | "unquantified";

export type Intervention =
  | "maintain"
  | "update_page"
  | "improve_journey"
  | "create_asset"
  | "investigate"
  | "technical_fix";

export type ReviewRequirement = "none" | "subject_matter_expert" | "legal" | "medical";

export type CoverageState = "answers" | "partially_answers" | "does_not_answer" | "unassessable";

/** What a page does about a specific need, with the evidence for that judgement. */
export type CoverageAssessment = {
  pageUrl: string;
  state: CoverageState;
  method: "lexical" | "semantic" | "manual";
  matchedTerms: string[];
  /** Short excerpts that justify the state, so a person can check it. */
  excerpts: string[];
  note: string;
};

export type BusinessFit = {
  state: EvidenceState;
  /** Why this business should serve this need, in words, not a score. */
  rationale: string;
  /** What the judgement rests on. */
  basis: string[];
};

export type NeedEvidence = {
  /** The customer problem, stated as a need rather than a keyword. */
  statement: string;
  audience: string | null;
  /** Where the need came from: a source, a customer question, a first-party query. */
  sources: string[];
  /** How many independent observations support it. */
  observations: number;
  /** The research found its own sources unusable. */
  sourcesUnusable?: boolean;
  /** The need was contradicted by evidence about the site or the market. */
  contradicted?: boolean;
  contradictionReason?: string;
};

export type RecommendationInput = {
  /** Null for a pure technical problem, which has no customer need. */
  need: NeedEvidence | null;
  businessFit: BusinessFit;
  /** What the site already does about the need. Empty when not assessed. */
  coverage: CoverageAssessment[];
  /** Whether the whole known inventory was retrieved and assessed. */
  coverageComplete: boolean;
  /** A verified technical problem, when the work is technical. */
  technical?: {
    verified: boolean;
    problem: string;
    affectedPages: number;
    /** Blocked fetches and rate limits are not verified defects. */
    causedByCrawlBlocking: boolean;
  } | null;
  measurement: BenefitMeasurement;
  /** Pages the work would change. Empty means a new asset or an investigation. */
  targetPages: string[];
  /** The specific change, or the bounded question for an investigation. */
  change: string;
  expectedBenefit: string;
  uncertainty: string[];
  effort: "small" | "medium" | "large";
  review?: ReviewRequirement;
  successMeasure: string;
};

export type RecommendationDecision = RecommendationInput & {
  evidenceState: EvidenceState;
  readiness: Readiness;
  tracks: BenefitTrack[];
  intervention: Intervention;
  review: ReviewRequirement;
  /** Why the decision came out this way, in order of precedence. */
  reasons: string[];
};

const NEED_STATEMENT_MIN = 12;

/**
 * Decide readiness from evidence, not from a score.
 *
 * Precedence matters: a contradicted premise is rejected before anything else is
 * considered, and a research-quality failure is rejected as business work even
 * though it is "supported" in the narrow sense that the sources really were bad.
 */
export function decideRecommendation(input: RecommendationInput): RecommendationDecision {
  const reasons: string[] = [];
  const tracks = tracksFor(input);
  const review = input.review ?? "none";

  // 1. A verified technical problem is actionable on its own terms. It needs no
  //    customer need and no demand estimate, but a blocked fetch is not a defect.
  if (input.technical) {
    if (input.technical.causedByCrawlBlocking) {
      reasons.push("the observation came from a blocked fetch or rate limit, which does not prove a defect for users or crawlers");
      return finish(input, tracks, review, {
        evidenceState: "unverified",
        readiness: "needs_investigation",
        intervention: "investigate",
        reasons,
      });
    }
    if (!input.technical.verified) {
      reasons.push("the technical problem has not been verified against the page");
      return finish(input, tracks, review, {
        evidenceState: "unverified",
        readiness: "needs_investigation",
        intervention: "investigate",
        reasons,
      });
    }
    reasons.push(`verified technical problem affecting ${input.technical.affectedPages} page(s)`);
    return finish(input, tracks, review, {
      evidenceState: "supported",
      readiness: "actionable",
      intervention: "technical_fix",
      reasons,
    });
  }

  // 2. Contradicted premises are rejected, never relabelled as a hypothesis.
  if (input.need?.contradicted) {
    reasons.push(input.need.contradictionReason ?? "the premise is contradicted by evidence");
    return finish(input, tracks, review, {
      evidenceState: "contradicted",
      readiness: "rejected",
      intervention: "maintain",
      reasons,
    });
  }

  // 3. Research that could not read its own sources is a pipeline-quality event.
  if (input.need?.sourcesUnusable) {
    reasons.push("the research found its own sources unusable, so this is a pipeline-quality failure rather than a customer need");
    return finish(input, tracks, review, {
      evidenceState: "unverified",
      readiness: "rejected",
      intervention: "maintain",
      reasons,
    });
  }

  if (!input.need || input.need.statement.trim().length < NEED_STATEMENT_MIN) {
    reasons.push("there is no stated customer need to act on");
    return finish(input, tracks, review, {
      evidenceState: "unverified",
      readiness: "research_backlog",
      intervention: "investigate",
      reasons,
    });
  }

  // 4. Business fit is its own proposition. An office address or a shared noun is
  //    not proof that this business should serve this need.
  if (input.businessFit.state === "contradicted") {
    reasons.push(`the business should not serve this need: ${input.businessFit.rationale}`);
    return finish(input, tracks, review, {
      evidenceState: "contradicted",
      readiness: "rejected",
      intervention: "maintain",
      reasons,
    });
  }

  const supporting = input.coverage.filter((row) => row.state === "answers" || row.state === "partially_answers");
  const adequate = input.coverage.filter((row) => row.state === "answers");

  // 5. An existing page that already answers the need changes the intervention:
  //    improve what exists instead of commissioning a duplicate.
  if (adequate.length > 0) {
    reasons.push(`existing coverage answers this need at ${adequate[0].pageUrl}`);
    if (input.change.trim().length === 0) {
      return finish(input, tracks, review, {
        evidenceState: "supported",
        readiness: "needs_investigation",
        intervention: "investigate",
        reasons,
      });
    }
  }

  // Finding a page is enough to act on it. Whole-site completeness only matters for
  // claiming absence: an unretrieved part of the site cannot prove a page is missing.
  const coverageResolved = input.coverage.length > 0;
  const evidenceState: EvidenceState = input.businessFit.state === "supported" ? "supported" : "unverified";

  // 6. A supported need with a verified intervention is actionable even when the
  //    organic benefit is unquantified. Missing keyword data is not missing value.
  if (input.businessFit.state === "supported" && coverageResolved && input.change.trim().length > 0) {
    if (adequate.length > 0) {
      reasons.push("improve the existing answer rather than creating a second one");
      return finish(input, tracks, review, {
        evidenceState: "supported",
        readiness: "actionable",
        intervention: "update_page",
        reasons,
      });
    }
    if (supporting.length > 0) {
      reasons.push("an existing page partly answers the need; the change completes it");
      return finish(input, tracks, review, {
        evidenceState: "supported",
        readiness: "actionable",
        intervention: "update_page",
        reasons,
      });
    }
    reasons.push(input.targetPages.length > 0
      ? "a verified gap on an existing page with a specific change"
      : "no existing page answers the need and the intervention is a new asset");
    return finish(input, tracks, review, {
      evidenceState: "supported",
      readiness: "actionable",
      intervention: input.targetPages.length > 0 ? "update_page" : "create_asset",
      reasons,
    });
  }

  // 7. A supported need whose coverage or solution is unresolved is a bounded
  //    investigation, not an open-ended "research more".
  if (input.businessFit.state === "supported") {
    reasons.push(input.coverage.length === 0
      ? "the need is supported but no page has been assessed against it"
      : "the need is supported but the coverage or the change is unresolved");
    return finish(input, tracks, review, {
      evidenceState,
      readiness: "needs_investigation",
      intervention: "investigate",
      reasons,
    });
  }

  // 8. A need with no business-fit evidence yet is backlog: worth keeping, not
  //    worth commissioning work for.
  reasons.push("the need is not yet shown to fit this business");
  return finish(input, tracks, review, {
    evidenceState: "unverified",
    readiness: "research_backlog",
    intervention: "investigate",
    reasons,
  });
}

function tracksFor(input: RecommendationInput): BenefitTrack[] {
  const tracks = new Set<BenefitTrack>();
  if (input.technical) tracks.add("technical_health");
  if (input.need) {
    tracks.add("customer_value");
    // Organic growth is a claim about search exposure, so it needs either a
    // measurement or a page the work would change. A technical fix alone makes no
    // such claim.
    if (input.measurement !== "unquantified" || input.targetPages.length > 0) tracks.add("organic_growth");
  }
  return [...tracks];
}

function finish(
  input: RecommendationInput,
  tracks: BenefitTrack[],
  review: ReviewRequirement,
  decided: Pick<RecommendationDecision, "evidenceState" | "readiness" | "intervention" | "reasons">
): RecommendationDecision {
  return {
    ...input,
    ...decided,
    tracks: decided.readiness === "rejected" ? [] : tracks,
    review,
  };
}

/** Runtime validation: a decision that cannot be read is not a decision. */
export function assertDecision(decision: RecommendationDecision): void {
  if (decision.readiness === "actionable") {
    if (decision.change.trim().length === 0) throw new Error("an actionable recommendation needs a stated change");
    if (decision.successMeasure.trim().length === 0) throw new Error("an actionable recommendation needs a success measure");
    if (decision.evidenceState === "contradicted") throw new Error("a contradicted premise cannot be actionable");
    if (decision.tracks.length === 0) throw new Error("an actionable recommendation needs at least one benefit track");
  }
  if (decision.readiness === "rejected" && decision.tracks.length > 0) {
    throw new Error("a rejected recommendation produces no benefit track");
  }
  if (decision.intervention === "investigate" && decision.readiness === "actionable") {
    throw new Error("an investigation is not actionable until its question is answered");
  }
}

/** Human-readable readiness, used by the board and the detail page. */
export const READINESS_LABELS: Record<Readiness, { label: string; hint: string }> = {
  actionable: {
    label: "Actionable",
    hint: "The need and the change are evidenced. A person decides whether to do it.",
  },
  needs_investigation: {
    label: "Needs investigation",
    hint: "The need is real; what the site already answers, or the right change, is unresolved.",
  },
  research_backlog: {
    label: "Research backlog",
    hint: "Worth keeping, not yet shown to fit this business.",
  },
  rejected: {
    label: "Rejected",
    hint: "A contradicted premise or a research-quality failure. Kept for audit, not offered as work.",
  },
};

export const MEASUREMENT_LABELS: Record<BenefitMeasurement, { label: string; hint: string }> = {
  observed_baseline: {
    label: "Observed baseline",
    hint: "The current state was measured. The future benefit is still a forecast.",
  },
  forecast: {
    label: "Forecast",
    hint: "A scenario computed from a measured baseline or market volume, with stated assumptions.",
  },
  unquantified: {
    label: "Impact not quantified",
    hint: "The benefit is real but not measured. That is not the same as no value.",
  },
};

export const TRACK_LABELS: Record<BenefitTrack, string> = {
  customer_value: "Customer value",
  organic_growth: "Organic growth",
  technical_health: "Technical health",
};
