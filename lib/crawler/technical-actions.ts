import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { emitConnectorEvent } from "@/lib/connectors/events";
import { REMEDIATION } from "@/lib/crawler/remediation";
import { technicalEvidenceSchema } from "@/lib/connectors/types";

const TECHNICAL_EVIDENCE_RECENCY_DAYS = 7;
const MAX_GROUP_ISSUES = 200;
const EXCLUDED_DETAIL_KINDS = new Set(["crawl_summary", "content_score"]);
const DUPLICATE_TYPES = new Set(["DUPLICATE_TITLE", "DUPLICATE_DESCRIPTION"]);
const PAYLOAD_CONTENT_TYPES = new Set(["MISSING_TITLE", "MISSING_DESCRIPTION", "DUPLICATE_TITLE", "DUPLICATE_DESCRIPTION"]);
const REASSESSMENT_OPERATION = "technical_action_reassessment";
const METADATA_SOURCE_PATHS: Record<string, string[]> = {
  "robots.txt": ["src/app/robots.ts", "src/app/robots.txt/route.ts", "public/robots.txt"],
  "sitemap.xml": ["src/app/sitemap.ts", "src/app/sitemap.xml/route.ts", "public/sitemap.xml"],
};
const json = (value: unknown) => value as Prisma.InputJsonValue;

export class TechnicalActionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = "TechnicalActionError"; }
}

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const stringList = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

function issueGroupSignature(issue: { type: string; details: Prisma.JsonValue | null; url: string }): string {
  const details = record(issue.details);
  if (DUPLICATE_TYPES.has(issue.type)) {
    const valueKey = issue.type === "DUPLICATE_TITLE" ? "title" : "description";
    const urls = stringList(details.urls).sort();
    const duplicateValue = typeof details[valueKey] === "string" ? details[valueKey] : null;
    return JSON.stringify({ type: issue.type, duplicateValue, urls });
  }
  return JSON.stringify({ type: issue.type, kind: typeof details.kind === "string" ? details.kind : "" });
}

function canonicalHost(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch { return null; }
}

function canonicalPageHost(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch { return null; }
}

function findTarget(
  issues: Array<{ url: string; type: string; details: Prisma.JsonValue | null }>,
  context: { canonicalOrigin: string; websiteInventory: Prisma.JsonValue; capabilities: Prisma.JsonValue },
) {
  const capabilities = record(context.capabilities);
  const supported = new Set(stringList(capabilities.supported));
  const sourceFiles = new Set(stringList(capabilities.sourceFiles));
  const inventory = Array.isArray(context.websiteInventory) ? context.websiteInventory : [];
  const routeByUrl = new Map<string, string>();
  for (const item of inventory) {
    const row = record(item);
    const route = typeof row.route === "string" ? row.route : "";
    const url = typeof row.url === "string" ? row.url : "";
    if (route) routeByUrl.set(route, route);
    if (url) routeByUrl.set(url, route || url);
  }
  const sourceName = issues[0]?.type === "MISSING_ROBOTS" ? "robots.txt"
    : issues[0]?.type === "MISSING_SITEMAP" ? "sitemap.xml" : null;
  if (sourceName) {
    const capability = sourceName === "robots.txt" ? "site_metadata.robots" : "site_metadata.sitemap";
    const route = `/${sourceName}`;
    const path = METADATA_SOURCE_PATHS[sourceName].find((item) => sourceFiles.has(item));
    if (!path || !supported.has(capability)) {
      throw new TechnicalActionError(`The current connector context does not support editing ${sourceName}`);
    }
    return { targetUrl: new URL(route, context.canonicalOrigin).toString(), requiredCapabilities: [capability],
      targetIdentity: { kind: "source_file", path } };
  }
  if (!PAYLOAD_CONTENT_TYPES.has(issues[0]?.type ?? "")) {
    throw new TechnicalActionError("This crawl issue type has no bounded Payload metadata remediation; it cannot be made preparable");
  }
  if (!supported.has("content.prepare")) throw new TechnicalActionError("The current connector context does not support bounded page preparation");
  const affected = new Set<string>();
  for (const issue of issues) {
    affected.add(issue.url);
    for (const url of stringList(record(issue.details).urls)) affected.add(url);
  }
  const origin = canonicalHost(context.canonicalOrigin);
  const target = [...affected].sort().find((url) => {
    if (canonicalPageHost(url) !== origin) return false;
    let route = "";
    try { route = new URL(url).pathname; } catch { return false; }
    return routeByUrl.has(route);
  });
  if (!target) throw new TechnicalActionError("The selected crawl issue group has no exact target in the current canonical inventory");
  return { targetUrl: target, requiredCapabilities: ["content.prepare"], targetIdentity: null };
}

export function technicalReassessmentRequestHash(input: {
  projectId: string; siteId: string; crawlId: string; expectedBindingGeneration: number; expectedContextRevision: string;
  issueIds: string[]; operatorRequestId: string; reason: string; existingActionId?: string; expectedActionRevision?: number;
}): string {
  return sha({ projectId: input.projectId, siteId: input.siteId, crawlId: input.crawlId,
    expectedBindingGeneration: input.expectedBindingGeneration, expectedContextRevision: input.expectedContextRevision,
    issueIds: [...input.issueIds].sort(), operatorRequestId: input.operatorRequestId, reason: input.reason,
    existingActionId: input.existingActionId ?? null, expectedActionRevision: input.expectedActionRevision ?? null });
}

export async function reassessTechnicalActionGroup(input: {
  projectId: string;
  siteId: string;
  crawlId: string;
  expectedBindingGeneration: number;
  expectedContextRevision: string;
  issueIds: string[];
  operatorRequestId: string;
  reason: string;
  existingActionId?: string;
  expectedActionRevision?: number;
}) {
  if (!input.issueIds.length || input.issueIds.length > MAX_GROUP_ISSUES || new Set(input.issueIds).size !== input.issueIds.length) {
    throw new TechnicalActionError("Select between 1 and 200 unique crawl issue IDs");
  }
  if (Boolean(input.existingActionId) !== Boolean(input.expectedActionRevision)) {
    throw new TechnicalActionError("Existing Action reassessment requires both Action ID and expected revision");
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${input.siteId} FOR UPDATE`;
    const requestHash = technicalReassessmentRequestHash(input);
    const receiptWhere = { projectId_operation_idempotencyKey: { projectId: input.projectId,
      operation: REASSESSMENT_OPERATION, idempotencyKey: input.operatorRequestId } };
    const priorReceipt = await tx.connectorOperationReceipt.findUnique({ where: receiptWhere });
    if (priorReceipt) {
      if (priorReceipt.requestHash !== requestHash) throw new TechnicalActionError("Operator request ID was already used with different reassessment inputs", 409);
      const priorAction = await tx.researchAction.findFirst({ where: { id: priorReceipt.actionId, siteId: input.siteId, projectId: input.projectId } });
      if (!priorAction || priorAction.revision !== priorReceipt.actionRevision) throw new TechnicalActionError("The completed reassessment revision is no longer current", 409);
      return { action: priorAction, reused: true };
    }
    const site = await tx.site.findFirst({ where: { id: input.siteId, projectId: input.projectId },
      select: { id: true, projectId: true, domain: true } });
    if (!site) throw new TechnicalActionError("Project site not found", 404);
    await tx.$queryRaw`SELECT "id" FROM "ConnectorBinding" WHERE "siteId" = ${site.id} FOR UPDATE`;
    const binding = await tx.connectorBinding.findUnique({ where: { siteId: site.id },
      select: { projectId: true, status: true, generation: true, executor: true } });
    if (!binding || binding.projectId !== input.projectId || binding.status !== "ACTIVE"
        || binding.executor !== "helloada" || binding.generation !== input.expectedBindingGeneration) {
      throw new TechnicalActionError("Active connector binding changed; refresh before reassessment");
    }
    const context = await tx.connectorContextSnapshot.findFirst({ where: { siteId: site.id, projectId: input.projectId } });
    if (!context || context.revision !== input.expectedContextRevision) {
      throw new TechnicalActionError("Current canonical connector context changed or is missing; sync context before reassessment");
    }
    if (Date.now() - context.observedAt.getTime() > 7 * 86_400_000 || context.observedAt.getTime() > Date.now()) {
      throw new TechnicalActionError("Current canonical connector context is stale; sync context before reassessment");
    }
    const contextOrigin = canonicalHost(context.canonicalOrigin);
    const siteOrigin = canonicalHost(`https://${site.domain}/`);
    if (!contextOrigin || contextOrigin !== siteOrigin) throw new TechnicalActionError("Connector context does not match the registered canonical site origin");

    const crawl = await tx.crawl.findFirst({ where: { id: input.crawlId, siteId: site.id, status: "COMPLETED", finishedAt: { not: null } },
      select: { id: true, siteId: true, status: true, finishedAt: true } });
    if (!crawl?.finishedAt) throw new TechnicalActionError("Selected completed crawl does not belong to this site");
    const crawlAge = Date.now() - crawl.finishedAt.getTime();
    if (crawlAge < 0 || crawlAge > TECHNICAL_EVIDENCE_RECENCY_DAYS * 86_400_000) {
      throw new TechnicalActionError("Selected crawl is outside the explicit 7-day technical evidence window");
    }
    const issues = await tx.crawlIssue.findMany({ where: { id: { in: input.issueIds }, crawlId: crawl.id },
      orderBy: [{ type: "asc" }, { url: "asc" }, { id: "asc" }],
      select: { id: true, crawlId: true, url: true, type: true, severity: true, message: true, details: true } });
    if (issues.length !== input.issueIds.length) throw new TechnicalActionError("One or more issue IDs do not belong to the selected completed crawl");
    if (issues.some((issue) => EXCLUDED_DETAIL_KINDS.has(String(record(issue.details).kind ?? "")))) {
      throw new TechnicalActionError("Crawl summary and content-score rows are not technical Action evidence");
    }
    const signature = issueGroupSignature(issues[0]);
    if (issues.some((issue) => issueGroupSignature(issue) !== signature)) {
      throw new TechnicalActionError("Selected issue IDs do not form one exact crawl issue group");
    }
    const typeRows = await tx.crawlIssue.findMany({ where: { crawlId: crawl.id, type: issues[0].type },
      select: { id: true, url: true, type: true, details: true } });
    const exactGroupIds = typeRows.filter((issue) => issueGroupSignature(issue) === signature).map((issue) => issue.id).sort();
    if (JSON.stringify(exactGroupIds) !== JSON.stringify(issues.map((issue) => issue.id).sort())) {
      throw new TechnicalActionError("Selected issue IDs do not cover the exact persisted crawl issue group");
    }
    const type = issues[0].type;
    const remediation = REMEDIATION[type];
    if (!remediation) throw new TechnicalActionError("No bounded remediation is defined for this crawl issue type");

    const detailsUrls = issues.flatMap((issue) => stringList(record(issue.details).urls));
    const affectedUrls = [...new Set([...issues.map((issue) => issue.url), ...detailsUrls])].sort();
    const pages = await tx.auditPage.findMany({ where: { crawlId: crawl.id, url: { in: affectedUrls } },
      orderBy: [{ url: "asc" }, { id: "asc" }],
      select: { id: true, crawlId: true, url: true, statusCode: true, title: true, description: true, canonical: true,
        h1Count: true, wordCount: true, contentScore: true, hasSchema: true, indexable: true } });
    if (PAYLOAD_CONTENT_TYPES.has(type) && affectedUrls.some((url) => !pages.some((page) => page.url === url))) {
      throw new TechnicalActionError("The completed crawl has no persisted AuditPage record for every affected Payload route");
    }
    const target = findTarget(issues, context);
    const orderedIssueIds = issues.map((issue) => issue.id).sort();
    const sourceFingerprint = sha({ siteId: site.id, crawlId: crawl.id, issueIds: orderedIssueIds });
    const technicalEvidence = technicalEvidenceSchema.parse({
      schemaVersion: "1.0", sourceKind: "crawl", siteId: site.id, crawlId: crawl.id,
      canonicalContextRevision: context.revision, canonicalOrigin: context.canonicalOrigin,
      completedAt: crawl.finishedAt.toISOString(), recencyLimitDays: TECHNICAL_EVIDENCE_RECENCY_DAYS,
      sourceFingerprint,
      issueRefs: issues.map((issue) => ({ id: issue.id, url: issue.url, type: issue.type, severity: issue.severity, message: issue.message })),
      pageRefs: pages.map((page) => ({ id: page.id, url: page.url, statusCode: page.statusCode, title: page.title,
        description: page.description, canonical: page.canonical, h1Count: page.h1Count, wordCount: page.wordCount,
        contentScore: page.contentScore, hasSchema: page.hasSchema, indexable: page.indexable })),
    });
    const issueSeverity = issues.reduce((best, issue) => ({ CRITICAL: 3, WARNING: 2, INFO: 1 }[issue.severity]
      > ({ CRITICAL: 3, WARNING: 2, INFO: 1 }[best] ?? 0) ? issue.severity : best), "INFO");
    const priority = issueSeverity === "CRITICAL" ? 90 : issueSeverity === "WARNING" ? 70 : 50;
    const title = `${remediation.title} — ${affectedUrls.length} page${affectedUrls.length === 1 ? "" : "s"}`;
    const recommendation = PAYLOAD_CONTENT_TYPES.has(type)
      ? `Prepare only the ${type.endsWith("TITLE") ? "title" : "meta description"} for ${target.targetUrl} using the cited completed-crawl evidence. This does not resolve the other affected URLs; reassess them separately. ${remediation.howToFix}`
      : remediation.howToFix;
    const evidence = {
      technicalEvidence,
      reassessment: { operatorRequestId: input.operatorRequestId, reason: input.reason },
      crawl_id: crawl.id,
      crawl_finished_at: crawl.finishedAt.toISOString(),
      issue_type: type,
      affected_pages: affectedUrls.length,
      urls: affectedUrls,
      source_fingerprint: sourceFingerprint,
      ...(target.targetIdentity ? { target_identity: target.targetIdentity } : {}),
    };
    const dedupeKey = `technical:${sourceFingerprint}`;

    const exactExisting = await tx.researchAction.findUnique({ where: { siteId_dedupeKey: { siteId: site.id, dedupeKey } } });
    if (!input.existingActionId && exactExisting) {
      throw new TechnicalActionError("This exact crawl issue group already has an Action; explicit reassessment requires its ID and revision", 409);
    }

    const actionData = {
      siteId: site.id, projectId: input.projectId, runId: null, findingId: null,
      source: "crawl_issue", kind: "fix_technical_issue", format: "technical",
      title, primaryQuery: null, targetUrl: target.targetUrl, recommendation,
      priorityRationale: `${issueSeverity.toLowerCase()} severity from completed crawl ${crawl.id}`,
      evidence: json(evidence), requiredCapabilities: json(target.requiredCapabilities),
      acceptanceCriteria: json([...(PAYLOAD_CONTENT_TYPES.has(type)
        ? [`Prepare metadata for the exact target page ${target.targetUrl}; this does not resolve other affected pages.`]
        : [`Resolve the selected ${issues.length} crawl issue${issues.length === 1 ? "" : "s"}.`]),
        "Verify the affected canonical route or source file after publication."]),
      dependencies: json([]), reassessmentConditions: json(["A newer completed crawl changes this issue group."]),
      priority, automationMode: "MANUAL" as const, dedupeKey,
    };
    let action;
    let actionEventType = "action.created";
    if (input.existingActionId) {
      await tx.$queryRaw`SELECT "id" FROM "ResearchAction" WHERE "id" = ${input.existingActionId} FOR UPDATE`;
      const current = await tx.researchAction.findFirst({ where: { id: input.existingActionId, siteId: site.id, projectId: input.projectId },
        include: { _count: { select: { drafts: true, deliveries: true } } } });
      if (!current || current.source !== "crawl_issue") throw new TechnicalActionError("Explicit existing Action is not a crawl issue for this site", 404);
      const currentEvidence = record(current.evidence);
      const priorTechnical = technicalEvidenceSchema.safeParse(currentEvidence.technicalEvidence);
      if (record(currentEvidence.reassessment).operatorRequestId === input.operatorRequestId
          && priorTechnical.success && priorTechnical.data.sourceFingerprint === sourceFingerprint) {
        return { action: current, reused: true };
      }
      if (current.revision !== input.expectedActionRevision) throw new TechnicalActionError("Existing Action revision changed; refresh before reassessment");
      if (exactExisting && exactExisting.id !== current.id) throw new TechnicalActionError("This exact crawl issue group already has another Action");
      if (current.status !== "PROPOSED" || !["NONE", "BLOCKED"].includes(current.preparationStatus)
          || current._count.drafts > 0 || current._count.deliveries > 0) {
        throw new TechnicalActionError("An Action with active review, preparation, draft, delivery, or terminal status cannot be reassessed");
      }
      const execution = await tx.connectorExecutionState.findUnique({ where: { actionId_actionRevision: {
        actionId: current.id, actionRevision: current.revision,
      } }, select: { status: true, ownerDecision: true, candidateRef: true, reviewUrl: true, reviewPackageHash: true } });
      const activeTask = await tx.agentTask.findFirst({ where: { actionId: current.id,
        status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] } }, select: { id: true } });
      if (execution?.ownerDecision || execution?.candidateRef || execution?.reviewUrl || execution?.reviewPackageHash
          || (execution && execution.status !== "preparation_blocked") || activeTask) {
        throw new TechnicalActionError("An Action with an exact owner decision, execution, candidate, review, or active task cannot be reassessed");
      }
      await emitConnectorEvent(tx, { projectId: input.projectId, siteId: site.id, actionId: current.id,
        actionRevision: current.revision, type: "action.revision.superseded", payload: {
          actionId: current.id, revision: current.revision, title: current.title, recommendation: current.recommendation,
          evidence: current.evidence, status: current.status.toLowerCase(), priority: current.priority,
          operatorRequestId: input.operatorRequestId, reason: input.reason,
        } });
      action = await tx.researchAction.update({ where: { id: current.id }, data: {
        ...actionData, revision: { increment: 1 }, preparationStatus: "NONE", preparationRequestId: null,
        status: "PROPOSED",
      } });
      actionEventType = "action.updated";
    } else {
      action = await tx.researchAction.create({ data: { ...actionData, owner: "crawl-reassessment" } });
    }
    await emitConnectorEvent(tx, { projectId: input.projectId, siteId: site.id, actionId: action.id,
      actionRevision: action.revision, type: actionEventType, payload: {
        actionId: action.id, revision: action.revision, title: action.title, recommendation: action.recommendation,
        status: action.status.toLowerCase(), priority: action.priority, technicalEvidence,
        operatorRequestId: input.operatorRequestId, reason: input.reason,
      } });
    await tx.connectorOperationReceipt.create({ data: { projectId: input.projectId, siteId: site.id, actionId: action.id,
      actionRevision: action.revision, operation: REASSESSMENT_OPERATION, idempotencyKey: input.operatorRequestId,
      requestHash, result: json({ actionId: action.id, revision: action.revision }) } });
    return { action, reused: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
