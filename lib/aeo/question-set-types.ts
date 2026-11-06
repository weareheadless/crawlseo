export type QuestionIntent = "discovery" | "comparison" | "suitability" | "local" | "trust_risk";
export type QuestionProvenance =
  | { kind: "business_knowledge"; documentId?: string; revision: number }
  | { kind: "research_run"; id: string }
  | { kind: "research_finding"; id: string; runId?: string }
  | { kind: "profile" }
  | { kind: "keyword_evidence"; query: string }
  | { kind: "not_recorded" };
export type GeneratedQuestion = { id: string; text: string; intent: QuestionIntent; provenance: QuestionProvenance[] };
export type QuestionSet = {
  contract: "aeo-question-set/1";
  version: string;
  locale: { country: string | null; language: string | null };
  questions: GeneratedQuestion[];
  provenance: QuestionProvenance[];
  /** Candidates the limit cut, so a short set is never mistaken for a full one. */
  omitted?: number;
  emptyReason?: "no_business_data";
};
