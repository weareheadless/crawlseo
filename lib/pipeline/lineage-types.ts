/** Public, credential/error-safe representation of recorded action provenance. */
export type LineageNodeKind = "business_revision" | "research_run" | "finding" | "source" | "action" | "draft" | "agent_attempt" | "approval" | "delivery" | "verification" | "outcome";
export type LineageNode = { id: string; kind: LineageNodeKind; label: string; status: string | null; occurredAt: string | null; href: string | null; details?: Record<string, string | number | boolean | null> };
export type LineageEdge = { from: string; to: string; relation: string };
export type LineageLinkState = "recorded" | "not_recorded" | "unsupported";
export type LineageLink = { state: LineageLinkState; reason?: string };
export type LineageListInfo = { returned: number; limit: number; hasMore: boolean };
export type ActionLineage = {
  siteId: string; actionId: string; nodes: LineageNode[]; edges: LineageEdge[];
  links: { business: LineageLink; research: LineageLink; delivery: LineageLink; verification: LineageLink; outcome: LineageLink };
  lists: { drafts: LineageListInfo; agentAttempts: LineageListInfo; deliveries: LineageListInfo; sources: LineageListInfo };
};

type DateValue = Date | string | null;
export type LineageRunInput = { id: string; siteId: string; projectId: string | null; title: string; status: string; createdAt: DateValue };
export type LineageFindingInput = { id: string; runId: string; summary: string; createdAt: DateValue; evidenceSourceIds: unknown };
export type LineageDraftInput = { id: string; siteId: string; title: string; status: string; createdAt: DateValue };
export type LineageAgentInput = { id: string; siteId: string; title?: string | null; status: string; createdAt: DateValue; actionRevision: number | null };
export type LineageDeliveryInput = { id: string; platform?: string; status: string; createdAt: DateValue; verifiedAt: DateValue; outcome: unknown; outcomeMeasuredAt: DateValue };
export type LineageSourceInput = { id: string; runId: string; title: string | null; url: string; provider: string; retrievedAt: DateValue };
export type ActionLineageProjectionInput = {
  id: string; siteId: string; projectId: string | null; title: string; status: string; revision: number;
  runId: string | null; findingId: string | null; evidence: unknown; createdAt: DateValue; approvedAt: DateValue;
  deliveredAt: DateValue; verifiedAt: DateValue; run: LineageRunInput | null; finding: LineageFindingInput | null;
  drafts: LineageDraftInput[]; agentTasks: LineageAgentInput[]; deliveries: LineageDeliveryInput[];
};
export type LineageProjectionBounds = { drafts: boolean; agentAttempts: boolean; deliveries: boolean; sources: boolean };
