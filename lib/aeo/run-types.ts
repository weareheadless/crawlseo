import type { ObservationProvider } from "./observation-types";

export type EvaluationTrigger = "scheduled" | "action";
export type EvaluationReceipt = {
  asked: number; stored: number; answerAbsent: number; failed: number; skippedByCap: number;
  costMicros: number; providers: ObservationProvider[]; questionSetVersion: string; runId: string;
  startedAt: string; finishedAt: string; status?: string; observationIds?: string[];
};
export type RunEvaluationInput = {
  projectId: string; siteId: string; trigger: EvaluationTrigger; actionId?: string; actionRevision?: number;
  cap?: number; providers?: ObservationProvider[]; questionSetVersion?: string;
  timeZone?: string;
  /** Internal action re-ask override. */
  question?: string;
};
