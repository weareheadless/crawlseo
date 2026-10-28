/** Public, credential/error-safe representation of recorded action provenance. */
export type LineageNodeKind = "business_revision" | "research_run" | "finding" | "source" | "action" | "draft" | "agent_attempt" | "delivery" | "verification" | "outcome";
export type LineageNode = { id: string; kind: LineageNodeKind; label: string; status: string | null; occurredAt: string | null; href: string | null; details?: Record<string, string | number | boolean | null> };
export type LineageEdge = { from: string; to: string; relation: string };
export type LineageLinkState = "recorded" | "not_recorded" | "unsupported";
export type LineageLink = { state: LineageLinkState; reason?: string };
export type ActionLineage = {
  siteId: string; actionId: string; nodes: LineageNode[]; edges: LineageEdge[];
  links: { business: LineageLink; research: LineageLink; delivery: LineageLink; verification: LineageLink; outcome: LineageLink };
  limits: { drafts: number; agentAttempts: number; deliveries: number; sources: number };
};
