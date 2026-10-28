import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";
import { sourceIdsForAction } from "@/lib/research/evidence";
import type { ActionLineage, LineageEdge, LineageLink, LineageNode } from "./lineage-types";

const LIMITS = { drafts: 100, agentAttempts: 100, deliveries: 20, sources: 200 } as const;
const iso = (date: Date | string | null | undefined) => date ? new Date(date).toISOString() : null;
const link = (state: LineageLink["state"], reason?: string): LineageLink => ({ state, ...(reason ? { reason } : {}) });
const safeUrl = (value: unknown) => typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;
// Prisma's varying JSON and included relation payloads are normalized by the projection below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Pure projection of a site-scoped action detail and same-run sources. Never infers historical edges. */
export function projectActionLineage(action: Row, sourceRows: Row[] = []): ActionLineage {
  const nodes: LineageNode[] = [], edges: LineageEdge[] = [];
  const add = (node: LineageNode, parent?: string, relation?: string) => { nodes.push(node); if (parent && relation) edges.push({ from: parent, to: node.id, relation }); };
  const aid = String(action.id), siteId = String(action.siteId);
  let business = link("not_recorded", "No pinned business document and revision are stored on this action evidence.");
  const evidence = action.evidence && typeof action.evidence === "object" ? action.evidence as Record<string, unknown> : {};
  const docId = evidence.business_document_id ?? evidence.businessDocumentId;
  const rev = evidence.business_revision ?? evidence.businessRevision;
  if (typeof docId === "string" && (typeof rev === "string" || typeof rev === "number")) {
    business = link("recorded");
    add({ id: `business:${docId}:${rev}`, kind: "business_revision", label: `Business revision ${rev}`, status: null, occurredAt: null, href: `/business?document=${encodeURIComponent(docId)}&revision=${encodeURIComponent(String(rev))}`, details: { documentId: docId, revision: String(rev) } }, aid, "informed_by");
  }
  const run = action.run && action.runId === action.run.id ? action.run : null;
  const finding = action.finding && action.findingId === action.finding.id ? action.finding : null;
  if (run) add({ id: run.id, kind: "research_run", label: run.title || "Research run", status: run.status ?? null, occurredAt: iso(run.createdAt), href: `/research?run=${encodeURIComponent(run.id)}` }, aid, "derived_from");
  if (finding && run && finding.runId === run.id) add({ id: finding.id, kind: "finding", label: finding.summary || "Finding", status: null, occurredAt: iso(finding.createdAt), href: `/findings?finding=${encodeURIComponent(finding.id)}` }, run.id, "identified");
  const ids = new Set(sourceIdsForAction(action));
  for (const source of sourceRows) if (ids.has(source.id) && run && source.runId === run.id) add({ id: source.id, kind: "source", label: source.title || "Research source", status: source.provider ?? null, occurredAt: iso(source.retrievedAt), href: safeUrl(source.url) }, finding && finding.runId === run.id ? finding.id : run.id, "supported_by");
  add({ id: aid, kind: "action", label: action.title || "Work action", status: action.status ?? null, occurredAt: iso(action.createdAt), href: `/work/${encodeURIComponent(aid)}`, details: { revision: Number.isFinite(action.revision) ? action.revision : 1 } });
  for (const draft of action.drafts ?? []) add({ id: draft.id, kind: "draft", label: draft.title || "Draft", status: draft.status ?? null, occurredAt: iso(draft.createdAt), href: `/content-studio?draft=${encodeURIComponent(draft.id)}` }, aid, "prepared_as");
  for (const task of action.agentTasks ?? []) add({ id: task.id, kind: "agent_attempt", label: task.title || `Agent attempt${task.actionRevision ? ` (revision ${task.actionRevision})` : ""}`, status: task.status ?? null, occurredAt: iso(task.createdAt), href: `/work/${encodeURIComponent(aid)}?attempt=${encodeURIComponent(task.id)}`, details: { actionRevision: task.actionRevision ?? null } }, aid, "attempted_by");
  for (const delivery of action.deliveries ?? []) add({ id: delivery.id, kind: "delivery", label: `Delivery${delivery.platform ? ` · ${delivery.platform}` : ""}`, status: delivery.status ?? null, occurredAt: iso(delivery.createdAt), href: `/work/${encodeURIComponent(aid)}?delivery=${encodeURIComponent(delivery.id)}` }, aid, "delivered_as");
  const verified = Boolean(action.verifiedAt) || (action.deliveries ?? []).some((d: Row) => d.verifiedAt);
  if (verified) add({ id: `verification:${aid}`, kind: "verification", label: "Recorded verification", status: "VERIFIED", occurredAt: iso(action.verifiedAt ?? (action.deliveries ?? []).find((d: Row) => d.verifiedAt)?.verifiedAt), href: `/work/${encodeURIComponent(aid)}` }, aid, "verified_by");
  const measured = (action.deliveries ?? []).find((d: Row) => d.outcomeMeasuredAt && d.outcome != null);
  if (measured) add({ id: `outcome:${measured.id}`, kind: "outcome", label: "Measured outcome", status: "MEASURED", occurredAt: iso(measured.outcomeMeasuredAt), href: `/work/${encodeURIComponent(aid)}?delivery=${encodeURIComponent(measured.id)}` }, `delivery:${measured.id}`, "measured_as");
  return { siteId, actionId: aid, nodes, edges, links: {
    business, research: run ? link("recorded") : link("not_recorded", "No recorded research run relationship."),
    delivery: (action.deliveries ?? []).length ? link("recorded") : link("not_recorded", "No delivery receipt recorded."),
    verification: verified ? link("recorded") : link("not_recorded", "No verification timestamp recorded; delivery is not verification."),
    outcome: measured ? link("recorded") : link("not_recorded", "No measured outcome is recorded; delivery or verification is not impact."),
  }, limits: { ...LIMITS } };
}

/** Read one action only within its site. Source lookup is constrained to the action's recorded run. */
export async function readActionLineage(siteId: string, actionId: string): Promise<ActionLineage> {
  const action = await db.researchAction.findFirst({ where: { id: actionId, siteId }, include: {
    run: { select: { id: true, siteId: true, projectId: true, title: true, status: true, createdAt: true } }, finding: true,
    drafts: { orderBy: { createdAt: "desc" }, take: LIMITS.drafts, select: { id: true, title: true, status: true, createdAt: true } },
    agentTasks: { where: { siteId }, orderBy: { createdAt: "desc" }, take: LIMITS.agentAttempts, select: { id: true, title: true, status: true, createdAt: true, actionRevision: true } },
    deliveries: { orderBy: { createdAt: "desc" }, take: LIMITS.deliveries, select: { id: true, platform: true, status: true, createdAt: true, verifiedAt: true, outcome: true, outcomeMeasuredAt: true } },
  } });
  if (!action) throw new ResearchServiceError("Action not found", 404);
  const runId = action.run && action.runId === action.run.id && action.run.siteId === siteId ? action.run.id : null;
  if (!runId) action.run = null;
  const ids = sourceIdsForAction(action);
  const sources = runId && ids.length ? await db.researchSource.findMany({ where: { id: { in: ids }, runId }, orderBy: { retrievedAt: "desc" }, take: LIMITS.sources, select: { id: true, runId: true, title: true, url: true, provider: true, retrievedAt: true } }) : [];
  return projectActionLineage(action as unknown as Row, sources as unknown as Row[]);
}
