export const OBSERVATION_PROVIDER_SURFACES = {
  perplexity: ["perplexity_api"],
  google: ["ai_overview"],
} as const;

export type ObservationProvider = keyof typeof OBSERVATION_PROVIDER_SURFACES;
export type ObservationSurface = (typeof OBSERVATION_PROVIDER_SURFACES)[ObservationProvider][number];
export type ObservationVerdict = "answer_present" | "answer_absent" | "brand_absent" | "no_brand_mention";

export interface CreateObservationInput {
  projectId: string;
  question: string;
  provider: ObservationProvider;
  surface: ObservationSurface;
  questionSetVersion: string;
  askedAt: Date;
  requestStatus: "succeeded" | "failed" | "over_budget";
  answerText?: string | null;
  promptText: string;
  locale: string;
  country?: string | null;
  device?: string | null;
  aiAnswerPresent: boolean;
  modelVersion?: string | null;
  runId: string;
  citedSources?: string[];
  mentionedBrands?: string[];
}

export type ObservationState =
  | { state: "no_observation" }
  | { state: "answer_absent"; observation: ObservationRecord }
  | { state: "observed"; observation: ObservationRecord }
  | { state: "over_budget" | "failed" };

export interface ObservationRecord {
  id: string;
  projectId: string;
  question: string;
  provider: string;
  modelSurface: string;
  observedAt: Date;
  questionSetVersion: string;
  answerText: string | null;
  promptText: string | null;
  locale: string | null;
  country: string | null;
  device: string | null;
  aiAnswerPresent: boolean | null;
  modelVersion: string | null;
  runId: string | null;
  citedSources: unknown;
  mentionedBrands: unknown;
}

export interface ObservationProjection {
  question: string;
  surface: string;
  verdict: ObservationVerdict | "no_observation";
  answerExcerpt: string | null;
  citedUrls: string[];
  competitorSourceOverlap: string[];
}
