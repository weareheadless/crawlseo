import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";

/**
 * Bridge: business research findings → funnel evidence.
 *
 * The spine keeps `ResearchRun`/`ResearchFinding` as its run and finding models
 * (plan §4), but the funnel only reasons from evidence. Without this bridge the
 * business-research lane never reaches the opportunity board, which is the whole
 * point of the "why" leg.
 *
 * Additive by design: it writes `research_finding` evidence and touches nothing
 * else. That is what makes it safe to run alongside the legacy pipeline while
 * that pipeline is still the producer.
 */

export type FindingBridgeDb = Pick<PrismaClient, "researchFinding" | "evidenceRecord"> & Parameters<typeof storeEvidenceRecord>[0];

type StoredFinding = {
  id: string;
  runId: string;
  type: string;
  theme: string;
  primaryQuery?: string | null;
  summary: string;
  confidence: number;
  sentiment: string | null;
  urgency: string | null;
  createdAt: Date;
};

/**
 * A finding becomes an opportunity input only when it names a winnable gap.
 * Everything else stays context: the taxonomy's O13/O14 detectors look for
 * `painPoint` and `positioningGap`, so those flags are set from the finding
 * type rather than guessed from prose.
 */
// The research runner emits the enum's types, not the detector's original
// vocabulary. These sets accept both, so a CONCERN is a pain point and a
// POSITIONING_GAP is a positioning gap without a second finding pipeline.
const PAIN_POINT_TYPES = new Set([
  "PAIN_POINT", "CUSTOMER_NEED", "FRICTION", "OBJECTION", "CONCERN", "MISCONCEPTION", "QUESTION", "CONTENT_GAP",
]);
const POSITIONING_TYPES = new Set([
  "COMPETITOR", "POSITIONING", "MARKET_GAP", "OPPORTUNITY", "POSITIONING_GAP", "COMPETITOR_GAP",
]);

export function findingDimensions(finding: StoredFinding): Record<string, string | number | boolean | null> {
  const isPainPoint = PAIN_POINT_TYPES.has(finding.type);
  const isPositioning = POSITIONING_TYPES.has(finding.type);
  return {
    findingId: finding.id,
    runId: finding.runId,
    findingType: finding.type,
    theme: finding.theme,
    // The phrase to validate; the join runner collects on this, not on the theme.
    query: finding.primaryQuery ?? null,
    // The detectors read these two flags; a finding without a winnable gap
    // stays context and never becomes a task.
    painPoint: isPainPoint ? "true" : null,
    painPointSummary: isPainPoint ? finding.summary : null,
    positioningGap: isPositioning ? "true" : null,
    gapSummary: isPositioning ? finding.summary : null,
    urgency: finding.urgency,
    sentiment: finding.sentiment,
  };
}

export type FindingBridgeResult = {
  findings: number;
  stored: number;
  /** Findings that carry a winnable gap and can therefore reach the board. */
  actionable: number;
};

export async function bridgeFindingsToEvidence(
  db: FindingBridgeDb,
  opts: { projectId: string; siteId?: string | null; runId: string }
): Promise<FindingBridgeResult> {
  const findings = (await db.researchFinding.findMany({
    where: { runId: opts.runId },
    select: {
      id: true,
      runId: true,
      type: true,
      theme: true,
      primaryQuery: true,
      summary: true,
      confidence: true,
      sentiment: true,
      urgency: true,
      createdAt: true,
    },
  })) as StoredFinding[];

  let stored = 0;
  let actionable = 0;
  for (const finding of findings) {
    const dimensions = findingDimensions(finding);
    if (dimensions.painPoint === "true" || dimensions.positioningGap === "true") actionable += 1;
    await storeEvidenceRecord(db, {
      projectId: opts.projectId,
      siteId: opts.siteId ?? null,
      kind: "research_finding",
      // The finding's own timestamp, so a replay is idempotent.
      observedAt: finding.createdAt,
      producer: "research-runner",
      dimensions,
      metrics: {
        // Declared, with a unit: confidence is a 0–100 judgement, not a count.
        "first_party:confidence": { value: finding.confidence, unit: "score", source: "first_party" },
      },
    });
    stored += 1;
  }

  return { findings: findings.length, stored, actionable };
}
