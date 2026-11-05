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
  bytesFetched: number;
  elapsedMs: number;
  remainingMs: number;
  deadlineAt: string;
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
  private bytesFetched = 0;
  private readonly startedAt = new Date();
  private readonly exhausted = new Set<string>();
  private readonly trace: AnalysisTraceEntry[] = [];

  constructor(policy: AnalysisResourcePolicy = ANALYSIS_RESOURCE_POLICY) {
    this.policy = policy;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt.getTime();
  }

  deadlineAt(): number {
    return this.startedAt.getTime() + this.policy.maxElapsedMs;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt() - Date.now());
  }

  canStart(): boolean {
    if (this.remainingMs() <= 0) {
      this.exhausted.add("elapsed_time");
      return false;
    }
    return true;
  }

  canCallModel(): boolean {
    if (!this.canStart()) return false;
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

  canFetch(): boolean {
    if (!this.canStart()) return false;
    if (this.liveFetches >= this.policy.maxLiveFetches) {
      this.exhausted.add("live_fetches");
      return false;
    }
    if (this.remainingBytes() <= 0) {
      this.exhausted.add("bytes");
      return false;
    }
    return true;
  }

  remainingBytes(): number {
    return Math.max(0, this.policy.maxTotalBytes - this.bytesFetched);
  }

  chargeFetchAttempt(): void {
    this.liveFetches += 1;
  }

  chargeBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.bytesFetched += Math.floor(bytes);
    if (this.bytesFetched >= this.policy.maxTotalBytes) this.exhausted.add("bytes");
  }

  /** The exact number of bytes a retrieval may read, never above the cap. */
  grantBytes(requested: number): number {
    if (!Number.isFinite(requested) || requested <= 0) return 0;
    return Math.min(Math.floor(requested), this.remainingBytes());
  }

  canRetrieve(count: number): boolean {
    if (!this.canStart()) return false;
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
      bytesFetched: this.bytesFetched,
      elapsedMs: this.elapsedMs(),
      remainingMs: this.remainingMs(),
      deadlineAt: new Date(this.deadlineAt()).toISOString(),
      startedAt: this.startedAt.toISOString(),
      exhausted: [...this.exhausted],
      trace: [...this.trace],
    };
  }
}
