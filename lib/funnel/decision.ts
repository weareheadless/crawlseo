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

export type Readiness = "actionable" | "needs_investigation" | "research_backlog" | "no_action" | "rejected";

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
  no_action: {
    label: "No change",
    hint: "The site already answers this need and no improvement is demonstrated.",
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
