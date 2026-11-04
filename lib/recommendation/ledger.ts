import {
  ANALYSIS_RESOURCE_POLICY,
  type AnalysisResourcePolicy,
  type AnalysisTraceEntry,
} from "@/lib/recommendation/contracts";

/**
 * One bounded budget for one candidate analysis.
 *
 * Every model call, repair, retrieval and evidence round is charged before it is
 * dispatched. The ledger is serialised with the decision so a run can show what
 * was actually spent. Exhaustion is an operational outcome, never proof that a
 * customer need does not exist.
 */
export type AnalysisLedgerSnapshot = {
  policyVersion: string;
  modelCalls: number;
  repairAttempts: number;
  evidenceRounds: number;
  retrievalRequests: number;
  liveFetches: number;
  startedAt: string;
  exhausted: string[];
  trace: AnalysisTraceEntry[];
};

export class AnalysisLedger {
  readonly policy: AnalysisResourcePolicy;
  private modelCalls = 0;
  private repairAttempts = 0;
  private evidenceRounds = 0;
  private retrievalRequests = 0;
  private liveFetches = 0;
  private readonly startedAt = new Date();
  private readonly exhausted = new Set<string>();
  private readonly trace: AnalysisTraceEntry[] = [];

  constructor(policy: AnalysisResourcePolicy = ANALYSIS_RESOURCE_POLICY) {
    this.policy = policy;
  }

  canCallModel(): boolean {
    if (this.modelCalls >= this.policy.maxModelCalls) {
      this.exhausted.add("model_calls");
      return false;
    }
    return true;
  }

  chargeModelCall(round: number, detail: string): void {
    this.modelCalls += 1;
    this.trace.push({ round, action: "final_decision", detail: detail.slice(0, 600), at: new Date().toISOString() });
  }

  canRepair(): boolean {
    if (this.repairAttempts >= this.policy.maxRepairAttempts) {
      this.exhausted.add("repair_attempts");
      return false;
    }
    return true;
  }

  chargeRepair(): void {
    this.repairAttempts += 1;
  }

  canRequestRound(): boolean {
    if (this.evidenceRounds >= this.policy.maxEvidenceRounds) {
      this.exhausted.add("evidence_rounds");
      return false;
    }
    return true;
  }

  startEvidenceRound(round: number, detail: string): void {
    this.evidenceRounds += 1;
    this.trace.push({ round, action: "request_evidence", detail: detail.slice(0, 600), at: new Date().toISOString() });
  }

  canRetrieve(count: number): boolean {
    if (this.retrievalRequests + count > this.policy.maxRetrievalRequests) {
      this.exhausted.add("retrieval_requests");
      return false;
    }
    return true;
  }

  chargeRetrieval(count: number): void {
    this.retrievalRequests += count;
  }

  remainingLiveFetches(): number {
    return Math.max(0, this.policy.maxLiveFetches - this.liveFetches);
  }

  chargeLiveFetches(count: number): void {
    this.liveFetches += count;
  }

  record(entry: AnalysisTraceEntry): void {
    this.trace.push(entry);
  }

  snapshot(): AnalysisLedgerSnapshot {
    return {
      policyVersion: this.policy.version,
      modelCalls: this.modelCalls,
      repairAttempts: this.repairAttempts,
      evidenceRounds: this.evidenceRounds,
      retrievalRequests: this.retrievalRequests,
      liveFetches: this.liveFetches,
      startedAt: this.startedAt.toISOString(),
      exhausted: [...this.exhausted],
      trace: [...this.trace],
    };
  }
}
