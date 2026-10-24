import {
  keywordEvidenceForAction,
  type KeywordEvidenceSummary,
} from "@/lib/research/evidence";

const OPPORTUNITY_SIGNALS = new Set([
  "striking_distance",
  "low_ctr",
  "content_decay",
  "cannibalization",
]);

const EFFORT_BY_KIND: Record<string, number> = {
  improve_metadata: 12,
  improve_page: 38,
  refresh_decaying_page: 46,
  create_article: 68,
  consolidate_pages: 78,
};

export type OpportunityPriority = {
  signals: string[];
  expectedClicks: number | null;
  impressions: number | null;
  position: number | null;
  ctr: number | null;
  expectedCtr: number | null;
  ctrGap: number | null;
  currentClicks: number | null;
  previousClicks: number | null;
  changePct: number | null;
  competingPages: number | null;
  impact: number;
  confidence: number;
  effort: number;
  seoScore: number;
  keyword: KeywordEvidenceSummary | null;
  keywordScore: number | null;
  finalPriority: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number): number {
  return Math.round(value);
}

function impactFromClicks(expectedClicks: number): number {
  return Math.max(5, Math.min(100, Math.round(Math.log10(1 + Math.max(0, expectedClicks)) * 34)));
}

function confidenceFromImpressions(impressions: number | null): number {
  if (impressions == null) return 40;
  if (impressions >= 500) return 88;
  if (impressions >= 100) return 74;
  if (impressions >= 20) return 58;
  return 40;
}

function effortFor(kind: string): number {
  return EFFORT_BY_KIND[kind] ?? 38;
}

export function keywordPriorityFor(
  volume: number | null | undefined,
  difficulty: number | null | undefined,
): number {
  const safeVolume = Math.max(0, finiteNumber(volume) ?? 0);
  const safeDifficulty = Math.max(0, Math.min(100, finiteNumber(difficulty) ?? 50));
  const demand = Math.min(70, Math.round(Math.log10(safeVolume + 1) * 18));
  return Math.max(20, Math.min(95, 35 + demand - Math.round(safeDifficulty * 0.2)));
}

export function opportunityPriorityForAction(action: {
  kind: string;
  priority: number;
  evidence?: unknown;
}): OpportunityPriority | null {
  const evidence = record(action.evidence);
  const metrics = record(evidence.metrics);
  const signals = Array.isArray(evidence.signals)
    ? evidence.signals.filter((signal): signal is string =>
        typeof signal === "string" && OPPORTUNITY_SIGNALS.has(signal))
    : [];
  const expectedClicks = finiteNumber(evidence.expected_clicks);
  const hasOpportunityEvidence = signals.length > 0 || expectedClicks != null || Object.keys(metrics).length > 0;
  if (!hasOpportunityEvidence) return null;

  const impressions = finiteNumber(metrics.impressions);
  const impact = impactFromClicks(expectedClicks ?? 0);
  const confidence = confidenceFromImpressions(impressions);
  const effort = effortFor(action.kind);
  const seoScore = round(impact * 0.55 + confidence * 0.25 + (100 - effort) * 0.2);
  const keyword = keywordEvidenceForAction(evidence);
  const keywordScore = keyword ? keywordPriorityFor(keyword.volume, keyword.difficulty) : null;

  return {
    signals,
    expectedClicks,
    impressions,
    position: finiteNumber(metrics.position),
    ctr: finiteNumber(metrics.ctr),
    expectedCtr: finiteNumber(metrics.expected_ctr),
    ctrGap: finiteNumber(metrics.ctr_gap),
    currentClicks: finiteNumber(metrics.current_clicks),
    previousClicks: finiteNumber(metrics.previous_clicks),
    changePct: finiteNumber(metrics.change_pct),
    competingPages: finiteNumber(metrics.competing_pages),
    impact,
    confidence,
    effort,
    seoScore,
    keyword,
    keywordScore,
    finalPriority: action.priority,
  };
}

export function opportunitySignalLabel(signal: string): string {
  switch (signal) {
    case "striking_distance":
      return "Striking distance";
    case "low_ctr":
      return "Low CTR";
    case "content_decay":
      return "Content decay";
    case "cannibalization":
      return "Cannibalization";
    default:
      return signal.replaceAll("_", " ");
  }
}
