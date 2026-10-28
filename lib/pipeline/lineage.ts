import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";
import { sourceIdsForAction } from "@/lib/research/evidence";
import type { ActionLineage, ActionLineageProjectionInput, LineageEdge, LineageLink, LineageNode, LineageProjectionBounds, LineageSourceInput } from "./lineage-types";

const LIMITS = { drafts: 100, agentAttempts: 100, deliveries: 20, sources: 200 } as const;
const iso = (value: Date | string | null): string | null => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const link = (state: LineageLink["state"], reason?: string): LineageLink => ({ state, ...(reason ? { reason } : {}) });
const localId = (value: string) => /^[A-Za-z0-9_-]+$/.test(value);
const sitePath = (siteId: string, ...parts: string[]): string | null =>
  [siteId, ...parts].every(localId) ? `/sites/${encodeURIComponent(siteId)}/${parts.map(encodeURIComponent).join("/")}` : null;
const safeExternalUrl = (value: string): string | null => {
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null; }
  catch { return null; }
};
const list = (returned: number, limit: number, hasMore: boolean) => ({ returned, limit, hasMore });

/** Pure projection of explicitly related, site-scoped records. It does not infer historical edges. */
export function projectActionLineage(input: ActionLineageProjectionInput, sourceRows: readonly LineageSourceInput[] = [], bounds: LineageProjectionBounds = { drafts: false, agentAttempts: false, deliveries: false, sources: false }): ActionLineage {
  const nodes: LineageNode[] = [], edges: LineageEdge[] = [];
  const add = (node: LineageNode, parent?: string, relation?: string) => { nodes.push(node); if (parent && relation) edges.push({ from: parent, to: node.id, relation }); };
  const { id: actionId, siteId } = input;
  const actionHref = sitePath(siteId, "actions", actionId);

  // No producer defines a supported immutable business-pin field in action evidence.
  const business = link("not_recorded", "No supported pinned business document/revision contract is recorded on actions; historical revision view unavailable.");
  const run = input.run && input.runId === input.run.id && input.run.siteId === siteId && input.run.projectId === input.projectId ? input.run : null;
  const finding = input.finding && input.findingId === input.finding.id && run && input.finding.runId === run.id ? input.finding : null;
  if (run) add({ id: run.id, kind: "research_run", label: run.title || "Research run", status: run.status || null, occurredAt: iso(run.createdAt), href: sitePath(siteId, "research", "runs", run.id) }, actionId, "derived_from");
  if (finding && run) add({ id: finding.id, kind: "finding", label: finding.summary || "Finding", status: null, occurredAt: iso(finding.createdAt), href: null }, run.id, "identified");
  const citedIds = new Set(sourceIdsForAction({ evidence: input.evidence, finding: input.finding }));
  const validSources = sourceRows.filter((source) => citedIds.has(source.id) && run && source.runId === run.id).slice(0, LIMITS.sources);
  for (const source of validSources) add({ id: source.id, kind: "source", label: source.title || "Research source", status: source.provider || null, occurredAt: iso(source.retrievedAt), href: safeExternalUrl(source.url) }, finding?.id ?? run?.id, "supported_by");

  add({ id: actionId, kind: "action", label: input.title || "Work action", status: input.status || null, occurredAt: iso(input.createdAt), href: actionHref, details: { revision: input.revision } });
  const drafts = input.drafts.filter((draft) => draft.siteId === siteId).slice(0, LIMITS.drafts);
  const attempts = input.agentTasks.filter((task) => task.siteId === siteId).slice(0, LIMITS.agentAttempts);
  const deliveries = input.deliveries.slice(0, LIMITS.deliveries);
  for (const draft of drafts) add({ id: draft.id, kind: "draft", label: draft.title || "Draft", status: draft.status || null, occurredAt: iso(draft.createdAt), href: null }, actionId, "prepared_as");
  for (const task of attempts) add({ id: task.id, kind: "agent_attempt", label: task.title || `Agent attempt${task.actionRevision ? ` (revision ${task.actionRevision})` : ""}`, status: task.status || null, occurredAt: iso(task.createdAt), href: null, details: { actionRevision: task.actionRevision } }, actionId, "attempted_by");
  if (input.approvedAt) add({ id: `approval:${actionId}`, kind: "approval", label: "Recorded approval", status: "APPROVED", occurredAt: iso(input.approvedAt), href: actionHref }, actionId, "approved_by");
  for (const delivery of deliveries) add({ id: delivery.id, kind: "delivery", label: `Delivery${delivery.platform ? ` · ${delivery.platform}` : ""}`, status: delivery.status || null, occurredAt: iso(delivery.createdAt), href: actionHref }, actionId, "delivered_as");
  // Timestamps establish that a verification event was recorded, not its pass/fail result.
  const verificationAt = input.verifiedAt ?? deliveries.find((delivery) => delivery.verifiedAt)?.verifiedAt ?? null;
  if (verificationAt) add({ id: `verification:${actionId}`, kind: "verification", label: "Verification timestamp recorded", status: null, occurredAt: iso(verificationAt), href: actionHref, details: { result: null } }, actionId, "verified_by");
  const measured = deliveries.find((delivery) => delivery.outcomeMeasuredAt && delivery.outcome != null);
  if (measured) add({ id: `outcome:${measured.id}`, kind: "outcome", label: "Outcome measurement recorded", status: null, occurredAt: iso(measured.outcomeMeasuredAt), href: actionHref, details: { causalImpact: null } }, measured.id, "measured_as");
  const sourceCount = validSources.length;
  return {
    siteId, actionId, nodes, edges,
    links: {
      business, research: run ? link("recorded") : link("not_recorded", "No site/project-matching research run relationship."),
      delivery: deliveries.length ? link("recorded") : link("not_recorded", "No delivery receipt recorded."),
      verification: verificationAt ? link("recorded", "Recorded timestamp does not establish verifier pass/fail.") : link("not_recorded", "No verification timestamp recorded; delivery is not verification."),
      outcome: measured ? link("recorded", "Recorded measurement does not prove causal impact.") : link("not_recorded", "No measured outcome is recorded; delivery or verification is not impact."),
    },
    lists: {
      drafts: list(drafts.length, LIMITS.drafts, bounds.drafts || input.drafts.length > LIMITS.drafts),
      agentAttempts: list(attempts.length, LIMITS.agentAttempts, bounds.agentAttempts || input.agentTasks.length > LIMITS.agentAttempts),
      deliveries: list(deliveries.length, LIMITS.deliveries, bounds.deliveries || input.deliveries.length > LIMITS.deliveries),
      sources: list(sourceCount, LIMITS.sources, bounds.sources || sourceRows.length > LIMITS.sources),
    },
  };
}

/** Read one action only within its site; source scope is additionally constrained by site and project. */
export async function readActionLineage(siteId: string, actionId: string): Promise<ActionLineage> {
  const action = await db.researchAction.findFirst({ where: { id: actionId, siteId }, include: {
    run: { select: { id: true, siteId: true, projectId: true, title: true, status: true, createdAt: true } },
    finding: { select: { id: true, runId: true, summary: true, createdAt: true, evidenceSourceIds: true } },
    drafts: { where: { siteId }, orderBy: { createdAt: "desc" }, take: LIMITS.drafts + 1, select: { id: true, siteId: true, title: true, status: true, createdAt: true } },
    agentTasks: { where: { siteId }, orderBy: { createdAt: "desc" }, take: LIMITS.agentAttempts + 1, select: { id: true, siteId: true, title: true, status: true, createdAt: true, actionRevision: true } },
    deliveries: { orderBy: { createdAt: "desc" }, take: LIMITS.deliveries + 1, select: { id: true, platform: true, status: true, createdAt: true, verifiedAt: true, outcome: true, outcomeMeasuredAt: true } },
  } });
  if (!action) throw new ResearchServiceError("Action not found", 404);
  const rawRun = action.run;
  const validRun = rawRun && rawRun.siteId === siteId && rawRun.projectId === action.projectId && action.runId === rawRun.id ? rawRun : null;
  const rawSources = validRun && sourceIdsForAction(action).length ? await db.researchSource.findMany({
    where: { id: { in: sourceIdsForAction(action) }, runId: validRun.id, run: { is: { siteId, projectId: action.projectId } } },
    orderBy: { retrievedAt: "desc" }, take: LIMITS.sources + 1,
    select: { id: true, runId: true, title: true, url: true, provider: true, retrievedAt: true },
  }) : [];
  const drafts = action.drafts.filter((row) => row.siteId === siteId);
  const agentTasks = action.agentTasks.filter((row) => row.siteId === siteId);
  const deliveries = action.deliveries;
  return projectActionLineage({
    id: action.id, siteId: action.siteId, projectId: action.projectId, title: action.title, status: action.status,
    revision: action.revision, runId: validRun?.id ?? null, findingId: action.findingId, evidence: action.evidence,
    createdAt: action.createdAt, approvedAt: action.approvedAt, deliveredAt: action.deliveredAt, verifiedAt: action.verifiedAt,
    run: validRun, finding: action.finding, drafts: drafts.slice(0, LIMITS.drafts), agentTasks: agentTasks.slice(0, LIMITS.agentAttempts), deliveries: deliveries.slice(0, LIMITS.deliveries),
  }, rawSources.slice(0, LIMITS.sources), {
    drafts: drafts.length > LIMITS.drafts, agentAttempts: agentTasks.length > LIMITS.agentAttempts,
    deliveries: deliveries.length > LIMITS.deliveries, sources: rawSources.length > LIMITS.sources,
  });
}
