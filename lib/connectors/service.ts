import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import type { ConnectorResearchProfileInput } from "@/lib/connectors/types";
import { db } from "@/lib/db";
import { emitConnectorEvent } from "@/lib/connectors/events";
import { technicalEvidenceSchema, type bindingTransferSchema, type connectorResearchPolicySchema } from "@/lib/connectors/types";
import type { z } from "zod";

export class ConnectorError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "ConnectorError"; }
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stableJson = (value: unknown): unknown => Array.isArray(value) ? value.map(stableJson)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableJson(item)]))
    : value;
const budgetFingerprint = (value: unknown) => sha(stableJson(value));
const technicalFingerprint = (siteId: string, crawlId: string, issueIds: string[]) => sha({
  siteId, crawlId, issueIds: [...issueIds].sort(),
});
const safeFailure = (value: string) => value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
  .replace(/(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 500);
const IMPLEMENTED_EXECUTORS = new Set(["helloada", "crawlseo-agent"]);

function assertExecutionAdapter(binding: { executor?: string } | null | undefined): void {
  if (!binding || !IMPLEMENTED_EXECUTORS.has(String(binding.executor))) {
    throw new ConnectorError("The active execution adapter is not implemented and cannot process owner work", 409);
  }
}

type BindingTransferInput = z.infer<typeof bindingTransferSchema>;
type ConnectorResearchPolicyInput = z.infer<typeof connectorResearchPolicySchema>;

export async function getConnectorResearchPolicy(principal: ServicePrincipalContext, siteId: string) {
  const site = await activeSite(principal.projectId, siteId);
  const [profile, policy] = await Promise.all([
    db.siteProfile.findUnique({ where: { siteId: site.id } }),
    db.researchPolicy.findUnique({ where: { siteId: site.id } }),
  ]);
  const constraints = profile?.constraints && typeof profile.constraints === "object" && !Array.isArray(profile.constraints)
    ? profile.constraints as Record<string, unknown> : {};
  return {
    schemaVersion: "1.0", projectId: principal.projectId, siteId: site.id,
    revision: policy?.revision ?? 0,
    topics: Array.isArray(profile?.topics) ? profile.topics : [],
    goals: Array.isArray(policy?.goals) ? policy.goals : Array.isArray(constraints.goals) ? constraints.goals : [],
    exclusions: Array.isArray(policy?.exclusions) ? policy.exclusions : Array.isArray(constraints.exclusions) ? constraints.exclusions : [],
    audience: typeof profile?.audience === "string" ? profile.audience : null,
    market: typeof constraints.market === "string" ? constraints.market : null,
    language: profile?.language ?? "en",
    providers: Array.isArray(policy?.providers) ? policy.providers : ["reddit", "news", "web"],
    cadence: policy?.cadence ?? "weekly", enabled: policy?.enabled ?? true,
    maxSources: policy?.maxSources ?? 30, monthlyBudget: policy?.monthlyBudget ?? 9,
    recencyDays: policy?.recencyDays ?? 90,
    autoDraft: policy?.autoDraft ?? false, autoAgent: policy?.autoAgent ?? false,
  };
}

export async function updateConnectorResearchPolicy(principal: ServicePrincipalContext, input: ConnectorResearchPolicyInput) {
  const site = await activeSite(principal.projectId, input.siteId);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${site.id} FOR UPDATE`;
      const current = await tx.researchPolicy.findUnique({ where: { siteId: site.id }, select: { revision: true } });
      const revision = current?.revision ?? 0;
      if (revision !== input.expectedRevision) throw new ConnectorError("Research policy changed; refresh before retrying", 409);
      const profile = await tx.siteProfile.findUnique({ where: { siteId: site.id }, select: { constraints: true } });
      const canonicalKnowledge = await tx.businessKnowledgeDocument.findUnique({ where: { projectId: principal.projectId }, select: { id: true } });
      const constraints = profile?.constraints && typeof profile.constraints === "object" && !Array.isArray(profile.constraints)
        ? { ...(profile.constraints as Record<string, unknown>) } : {};
      constraints.exclusions = input.exclusions;
      constraints.goals = input.goals;
      if (input.market) constraints.market = input.market;
      else delete constraints.market;
      const savedProfile = await tx.siteProfile.upsert({
        where: { siteId: site.id },
        create: { siteId: site.id, projectId: principal.projectId, language: input.language,
          topics: canonicalKnowledge ? undefined : json(input.topics), audience: canonicalKnowledge ? undefined : (input.audience === null ? Prisma.JsonNull : json(input.audience)),
          constraints: json(constraints) },
        update: { language: input.language, ...(canonicalKnowledge ? {} : { topics: json(input.topics), audience: input.audience === null ? Prisma.JsonNull : json(input.audience) }), constraints: json(constraints) },
      });
      const policyData = { enabled: input.enabled, cadence: input.cadence, providers: json(input.providers),
        goals: json(input.goals), exclusions: json(input.exclusions), recencyDays: input.recencyDays,
        maxSources: input.maxSources, monthlyBudget: input.monthlyBudget, autoDraft: input.autoDraft, autoAgent: input.autoAgent };
      const policy = current
        ? await tx.researchPolicy.update({ where: { siteId: site.id }, data: { ...policyData, revision: { increment: 1 } } })
        : await tx.researchPolicy.create({ data: { siteId: site.id, ...policyData, revision: 1 } });
      return { schemaVersion: "1.0", projectId: principal.projectId, siteId: site.id, revision: policy.revision,
        topics: canonicalKnowledge ? (Array.isArray(savedProfile.topics) ? savedProfile.topics : []) : input.topics,
        goals: input.goals, exclusions: input.exclusions, recencyDays: input.recencyDays,
        audience: canonicalKnowledge ? (typeof savedProfile.audience === "string" ? savedProfile.audience : null) : input.audience, market: input.market, language: input.language,
        providers: input.providers, cadence: input.cadence, enabled: input.enabled, maxSources: input.maxSources,
        monthlyBudget: input.monthlyBudget, autoDraft: input.autoDraft, autoAgent: input.autoAgent };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if ((error as { code?: string }).code === "P2034") throw new ConnectorError("Research policy changed concurrently; refresh before retrying", 409);
    throw error;
  }
}

export async function updateConnectorResearchProfile(
  principal: ServicePrincipalContext,
  input: ConnectorResearchProfileInput,
) {
  const site = await activeSite(principal.projectId, input.siteId);
  // A retry may observe an advanced revision but the same profile content.
  // Bind idempotency to content, not to the revision it was first written at.
  const requestHash = sha({
    siteId: input.siteId,
    profile: input.profile,
    researchPolicy: input.researchPolicy,
    seoResearch: input.seoResearch,
  });
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${site.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SiteProfile" WHERE "siteId" = ${site.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ResearchPolicy" WHERE "siteId" = ${site.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SeoResearchPolicy" WHERE "siteId" = ${site.id} FOR UPDATE`;

      const prior = await tx.connectorOperationReceipt.findUnique({
        where: {
          projectId_operation_idempotencyKey: {
            projectId: principal.projectId,
            operation: "research_profile",
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { requestHash: true, result: true },
      });
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new ConnectorError("Idempotency key was reused for a different research profile", 409);
        }
        return prior.result;
      }

      const current = await tx.researchPolicy.findUnique({
        where: { siteId: site.id },
        select: { revision: true },
      });
      const revision = current?.revision ?? 0;
      if (revision !== input.expectedRevision) {
        throw new ConnectorError("Research profile changed; refresh before retrying", 409);
      }

      const constraints = {
        market: input.profile.market,
        goals: input.profile.goals,
        exclusions: input.profile.exclusions,
      };
      const canonicalKnowledge = await tx.businessKnowledgeDocument.findUnique({ where: { projectId: principal.projectId }, select: { id: true } });
      const savedProfile = await tx.siteProfile.upsert({
        where: { siteId: site.id },
        create: {
          siteId: site.id,
          projectId: principal.projectId,
          language: input.profile.language,
          topics: canonicalKnowledge ? undefined : input.profile.topics,
          audience: canonicalKnowledge ? undefined : (input.profile.audience === null ? Prisma.JsonNull : input.profile.audience),
          constraints,
        },
        update: {
          language: input.profile.language,
          ...(canonicalKnowledge ? {} : { topics: input.profile.topics, audience: input.profile.audience === null ? Prisma.JsonNull : input.profile.audience }),
          constraints,
        },
      });

      const policyData = {
        enabled: input.researchPolicy.enabled,
        cadence: input.researchPolicy.cadence,
        providers: input.researchPolicy.providers,
        goals: input.profile.goals,
        exclusions: input.profile.exclusions,
        recencyDays: input.researchPolicy.recencyDays,
        maxSources: input.researchPolicy.maxSources,
        monthlyBudget: input.researchPolicy.monthlyBudget,
        autoDraft: input.researchPolicy.autoDraft,
        autoAgent: input.researchPolicy.autoAgent,
      };
      const policy = current
        ? await tx.researchPolicy.update({
            where: { siteId: site.id },
            data: { ...policyData, revision: { increment: 1 } },
          })
        : await tx.researchPolicy.create({
            data: { siteId: site.id, ...policyData, revision: 1 },
          });

      await tx.seoResearchPolicy.upsert({
        where: { siteId: site.id },
        create: {
          projectId: principal.projectId,
          siteId: site.id,
          ...input.seoResearch,
        },
        update: { ...input.seoResearch },
      });

      const result = {
        schemaVersion: "1.0",
        projectId: principal.projectId,
        siteId: site.id,
        revision: policy.revision,
        profile: canonicalKnowledge ? { ...input.profile,
          topics: Array.isArray(savedProfile.topics) ? savedProfile.topics as string[] : [],
          audience: typeof savedProfile.audience === "string" ? savedProfile.audience : null,
        } : input.profile,
        researchPolicy: input.researchPolicy,
        seoResearch: input.seoResearch,
      };
      await tx.connectorOperationReceipt.create({
        data: {
          projectId: principal.projectId,
          siteId: site.id,
          actionId: "config:research-profile",
          actionRevision: 0,
          operation: "research_profile",
          idempotencyKey: input.idempotencyKey,
          requestHash,
          result,
        },
      });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if ((error as { code?: string }).code === "P2034") {
      throw new ConnectorError("Research profile changed concurrently; refresh and retry", 409);
    }
    throw error;
  }
}

export async function transferConnectorBinding(principal: ServicePrincipalContext, input: BindingTransferInput) {
  if (input.expectedExecutor === input.nextExecutor) throw new ConnectorError("Transfer must select a different executor");
  if (input.nextExecutor !== "helloada" && input.nextExecutor !== "crawlseo-agent") {
    throw new ConnectorError(`The ${input.nextExecutor} execution adapter is not implemented and cannot be activated`, 409);
  }
  const requestHash = sha({ siteId: input.siteId, expectedGeneration: input.expectedGeneration,
    expectedExecutor: input.expectedExecutor, nextExecutor: input.nextExecutor, reason: input.reason });
  try {
    return await db.$transaction(async (tx) => {
      const prior = await tx.connectorBindingTransfer.findUnique({
        where: { projectId_idempotencyKey: { projectId: principal.projectId, idempotencyKey: input.idempotencyKey } },
      });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ConnectorError("Idempotency key was reused for a different transfer", 409);
        return prior;
      }
      const site = await tx.site.findFirst({ where: { id: input.siteId, projectId: principal.projectId }, select: { id: true } });
      if (!site) throw new ConnectorError("Project site not found", 404);
      await tx.$queryRaw`SELECT id FROM "ConnectorBinding" WHERE "siteId" = ${site.id} FOR UPDATE`;
      const binding = await tx.connectorBinding.findUnique({ where: { siteId: site.id } });
      if (!binding || binding.status !== "ACTIVE" || binding.executor !== input.expectedExecutor || binding.generation !== input.expectedGeneration) {
        throw new ConnectorError("Connector binding changed; refresh before transferring", 409);
      }
      const [unacked, unresolvedBudget, unresolvedExecution] = await Promise.all([
        tx.connectorEvent.count({ where: { projectId: principal.projectId, siteId: site.id, acknowledgedAt: null } }),
        tx.researchBudgetReservation.count({ where: { projectId: principal.projectId, siteId: site.id, status: { in: ["RESERVED", "UNCERTAIN"] } } }),
        tx.connectorExecutionState.count({ where: { projectId: principal.projectId, siteId: site.id, status: { in: ["preparation_ready", "owner_decision"] } } }),
      ]);
      if (unacked || unresolvedBudget || unresolvedExecution) throw new ConnectorError("Transfer requires acknowledged events, reconciled budget reservations, and no candidate awaiting an owner decision", 409);
      const updated = await tx.connectorBinding.updateMany({
        where: { id: binding.id, generation: input.expectedGeneration, executor: input.expectedExecutor, status: "ACTIVE" },
        data: { executor: input.nextExecutor, generation: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConnectorError("Connector binding changed during transfer", 409);
      const transfer = await tx.connectorBindingTransfer.create({ data: {
        projectId: principal.projectId, siteId: site.id, idempotencyKey: input.idempotencyKey, requestHash,
        fromExecutor: input.expectedExecutor, toExecutor: input.nextExecutor,
        fromGeneration: input.expectedGeneration, toGeneration: input.expectedGeneration + 1, reason: input.reason,
      } });
      await emitConnectorEvent(tx, { projectId: principal.projectId, siteId: site.id, type: "binding.transferred",
        payload: { fromExecutor: input.expectedExecutor, toExecutor: input.nextExecutor, fromGeneration: input.expectedGeneration,
          toGeneration: input.expectedGeneration + 1, reason: input.reason } });
      return transfer;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const prior = await db.connectorBindingTransfer.findUnique({ where: { projectId_idempotencyKey: { projectId: principal.projectId, idempotencyKey: input.idempotencyKey } } });
      if (prior?.requestHash === requestHash) return prior;
      if (prior) throw new ConnectorError("Idempotency key was reused for a different transfer", 409);
    }
    throw error;
  }
}

async function activeSite(projectId: string, siteId?: string) {
  const site = await db.site.findFirst({
    where: { projectId, ...(siteId ? { id: siteId } : {}) },
    include: { project: { select: { id: true, externalProjectId: true, workspaceId: true } }, connectorBinding: true },
    orderBy: { createdAt: "asc" },
  });
  if (!site || !site.project) throw new ConnectorError("Project site not found", 404);
  return site;
}

export async function connectorCapabilities(principal: ServicePrincipalContext, siteId: string) {
  const site = await activeSite(principal.projectId, siteId);
  return {
    schemaVersion: "1.0",
    projectId: principal.projectId,
    siteId: site.id,
    // Backend capabilities do not imply that this credential has write access.
    credentialScopes: [...new Set(principal.scopes)].sort(),
    binding: site.connectorBinding ? {
      executor: site.connectorBinding.executor,
      generation: site.connectorBinding.generation,
      status: site.connectorBinding.status.toLowerCase(),
      executionSupported: ["helloada", "crawlseo-agent"].includes(site.connectorBinding.executor),
    } : null,
    executionExecutors: ["helloada", "crawlseo-agent"],
    capabilities: ["policy.read", "policy.write", "findings.read", "actions.read", "preparation.accept", "preparation.cancel", "execution.status.write", "context.write", "events.poll", "events.ack", "budget.read", "budget.policy.write", "budget.reserve", "budget.settle", "providers.reddit-rss", "providers.google-news-rss"],
    researchProviders: [
      { id: "reddit", implementation: "reddit_rss", billable: false },
      { id: "news", implementation: "google_news_rss", billable: false },
      { id: "web", supported: false, reason: "General web search is not implemented; Google News RSS is available through the news provider" },
      { id: "competitor", supported: false, reason: "Competitor research requires a domain-specific, budget-reserved provider operation" },
    ],
  };
}

function assertOrigin(raw: string, expectedHost: string) {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ConnectorError("canonicalOrigin must be a valid origin"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.hostname.toLowerCase().replace(/\.$/, "") !== expectedHost.toLowerCase().replace(/\.$/, "")) {
    throw new ConnectorError("canonicalOrigin must match the registered site origin");
  }
  return parsed.origin;
}

function reviewWorkspaceOrigin(capabilities: unknown): string | null {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  const raw = (capabilities as Record<string, unknown>).reviewOrigin;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new ConnectorError("reviewOrigin must be a valid owner workspace origin");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ConnectorError("reviewOrigin must be a valid owner workspace origin"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ConnectorError("reviewOrigin must be a bare HTTP(S) origin without credentials or path");
  }
  return parsed.origin;
}

export async function saveContextSnapshot(
  principal: ServicePrincipalContext,
  input: {
    siteId: string; revision: string; expectedRevision: string | null; canonicalOrigin: string;
    observedAt: string; websiteInventory: unknown; businessFacts: unknown; capabilities: unknown;
  },
) {
  const site = await activeSite(principal.projectId, input.siteId);
  const origin = assertOrigin(input.canonicalOrigin, site.domain);
  const nextReviewOrigin = reviewWorkspaceOrigin(input.capabilities);
  if (!input.revision.trim() || input.revision.length > 200) throw new ConnectorError("Context revision is invalid");
  const observedAt = new Date(input.observedAt);
  if (Number.isNaN(observedAt.getTime()) || observedAt.getTime() > Date.now() + 5 * 60_000) throw new ConnectorError("observedAt is invalid");
  const value = { projectId: principal.projectId, siteId: site.id, revision: input.revision, canonicalOrigin: origin, observedAt,
    websiteInventory: json(input.websiteInventory), businessFacts: json(input.businessFacts), capabilities: json(input.capabilities) };
  try {
    return await db.$transaction(async (tx) => {
      // Serialize the expected-revision comparison with writes. Checking before
      // the transaction permits concurrent stale writers to both pass.
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${site.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ConnectorBinding" WHERE "siteId" = ${site.id} FOR UPDATE`;
      const previous = await tx.connectorContextSnapshot.findUnique({ where: { siteId: site.id } });
      if ((previous?.revision ?? null) !== input.expectedRevision) throw new ConnectorError("Context revision changed; refresh before retrying", 409);
      const previousReviewOrigin = reviewWorkspaceOrigin(previous?.capabilities);
      if (previousReviewOrigin && previousReviewOrigin !== nextReviewOrigin) {
        const [queuedPreparations, activeReviews] = await Promise.all([
          tx.researchAction.count({ where: { siteId: site.id, preparationStatus: { in: ["QUEUED", "READY"] } } }),
          tx.connectorExecutionState.count({ where: { projectId: principal.projectId, siteId: site.id,
            status: { in: ["preparation_ready", "owner_decision"] } } }),
        ]);
        if (queuedPreparations || activeReviews) throw new ConnectorError("Owner review workspace cannot change while preparation or approval is active", 409);
      }
      if (input.revision === previous?.revision) {
        if (sha({ canonicalOrigin: origin, observedAt: observedAt.toISOString(), websiteInventory: input.websiteInventory,
          businessFacts: input.businessFacts, capabilities: input.capabilities }) !== sha({ canonicalOrigin: previous.canonicalOrigin,
          observedAt: previous.observedAt.toISOString(), websiteInventory: previous.websiteInventory,
          businessFacts: previous.businessFacts, capabilities: previous.capabilities })) throw new ConnectorError("Context revision cannot be reused for different data", 409);
        return previous;
      }
      const snapshot = await tx.connectorContextSnapshot.upsert({ where: { siteId: site.id }, create: value, update: value });
      await emitConnectorEvent(tx, { projectId: principal.projectId, siteId: site.id, type: "context.updated",
        payload: { revision: snapshot.revision, observedAt: snapshot.observedAt.toISOString() } });
      return snapshot;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (["P2002", "P2025", "P2034"].includes((error as { code?: string }).code ?? "")) throw new ConnectorError("Context revision changed; refresh before retrying", 409);
    throw error;
  }
}

export async function currentContext(principal: ServicePrincipalContext, siteId?: string) {
  const site = await activeSite(principal.projectId, siteId);
  return db.connectorContextSnapshot.findFirst({ where: { projectId: principal.projectId, siteId: site.id } });
}

async function envelope(action: Awaited<ReturnType<typeof actionRow>>) {
  const evidence = action.evidence && typeof action.evidence === "object" && !Array.isArray(action.evidence)
    ? action.evidence as Record<string, unknown> : {};
  const finding = envelopeEvidenceIds(action.finding?.evidenceSourceIds);
  const inline = envelopeEvidenceIds(evidence.source_ids);
  const findingIds = finding.ids;
  const inlineIds = inline.ids;
  const duplicateIds = [
    ...new Set(findingIds.filter((id, index, all) => all.indexOf(id) !== index)),
    ...new Set(inlineIds.filter((id, index, all) => all.indexOf(id) !== index)),
  ];
  const invalidEvidenceReferences = [...new Set([...finding.invalidIds, ...inline.invalidIds, ...duplicateIds])];
  const sourceIds = [...new Set([...findingIds, ...inlineIds])];
  const sources = await db.researchSource.findMany({
    where: { id: { in: sourceIds }, run: { projectId: action.projectId, siteId: action.siteId } },
    select: { id: true, provider: true, url: true, title: true, publishedAt: true, retrievedAt: true, language: true, metadata: true, run: { select: { brief: true, recencyDays: true, policyRevision: true } } },
  });
  const [context, currentPolicy] = await Promise.all([
    db.connectorContextSnapshot.findFirst({ where: { projectId: action.projectId!, siteId: action.siteId }, select: { revision: true, canonicalOrigin: true } }),
    db.researchPolicy.findUnique({ where: { siteId: action.siteId }, select: { revision: true, recencyDays: true } }),
  ]);
  const project = await db.project.findUnique({ where: { id: action.projectId! }, select: { externalProjectId: true } });
  const execution = await db.connectorExecutionState.findUnique({ where: { actionId_actionRevision: { actionId: action.id, actionRevision: action.revision } } });
  const rawTechnical = evidence.technicalEvidence;
  const parsedTechnical = technicalEvidenceSchema.safeParse(rawTechnical);
  const technicalEvidence = parsedTechnical.success ? parsedTechnical.data : null;
  let technicalEvidenceComplete = false;
  let technicalEvidenceStale = false;
  let invalidTechnicalEvidenceReferences = Boolean(rawTechnical !== undefined && !parsedTechnical.success);
  const unavailableTechnicalEvidenceIds: string[] = [];
  if (technicalEvidence) {
    const issueIds = technicalEvidence.issueRefs.map((row) => row.id);
    const pageIds = technicalEvidence.pageRefs.map((row) => row.id);
    const shapeInvalid = technicalEvidence.siteId !== action.siteId
      || technicalEvidence.canonicalContextRevision !== context?.revision
      || technicalEvidence.canonicalOrigin !== context?.canonicalOrigin
      || technicalEvidence.sourceFingerprint !== technicalFingerprint(action.siteId, technicalEvidence.crawlId, issueIds)
      || new Set(issueIds).size !== issueIds.length || new Set(pageIds).size !== pageIds.length;
    const crawl = !shapeInvalid ? await db.crawl.findFirst({ where: {
      id: technicalEvidence.crawlId, siteId: action.siteId, status: "COMPLETED",
    }, select: { id: true, siteId: true, status: true, finishedAt: true } }) : null;
    const [issueRows, pageRows] = crawl ? await Promise.all([
      db.crawlIssue.findMany({ where: { id: { in: issueIds }, crawlId: crawl.id },
        select: { id: true, crawlId: true, url: true, type: true, severity: true, message: true } }),
      db.auditPage.findMany({ where: { id: { in: pageIds }, crawlId: crawl.id },
        select: { id: true, crawlId: true, url: true, statusCode: true, title: true, description: true, canonical: true,
          h1Count: true, wordCount: true, contentScore: true, hasSchema: true, indexable: true } }),
    ]) : [[], []];
    const issuesById = new Map(issueRows.map((row) => [row.id, row]));
    const pagesById = new Map(pageRows.map((row) => [row.id, row]));
    for (const ref of technicalEvidence.issueRefs) {
      const row = issuesById.get(ref.id);
      if (!row) unavailableTechnicalEvidenceIds.push(ref.id);
      else if (row.url !== ref.url || row.type !== ref.type || row.severity !== ref.severity || row.message !== ref.message) {
        invalidTechnicalEvidenceReferences = true;
      }
    }
    for (const ref of technicalEvidence.pageRefs) {
      const row = pagesById.get(ref.id);
      if (!row) unavailableTechnicalEvidenceIds.push(ref.id);
      else if (row.url !== ref.url || row.statusCode !== ref.statusCode || row.title !== ref.title
          || row.description !== ref.description || row.canonical !== ref.canonical || row.h1Count !== ref.h1Count
          || row.wordCount !== ref.wordCount || row.contentScore !== ref.contentScore || row.hasSchema !== ref.hasSchema
          || row.indexable !== ref.indexable) invalidTechnicalEvidenceReferences = true;
    }
    if (shapeInvalid || !crawl || crawl.finishedAt?.toISOString() !== technicalEvidence.completedAt) {
      invalidTechnicalEvidenceReferences = true;
    }
    const crawlAgeMs = crawl?.finishedAt ? Date.now() - crawl.finishedAt.getTime() : Number.POSITIVE_INFINITY;
    technicalEvidenceStale = crawlAgeMs < 0 || crawlAgeMs > technicalEvidence.recencyLimitDays * 86_400_000;
    technicalEvidenceComplete = Boolean(crawl && !shapeInvalid && !invalidTechnicalEvidenceReferences
      && unavailableTechnicalEvidenceIds.length === 0 && !technicalEvidenceStale
      && issueRows.length === issueIds.length && pageRows.length === pageIds.length);
  }
  return {
    schemaVersion: "1.0", project: { id: action.projectId, externalId: project?.externalProjectId ?? null },
    site: { id: action.siteId, canonicalOrigin: `https://${action.site.domain}/` },
    id: action.id, revision: action.revision,
    problem: action.finding?.summary ?? action.title, recommendation: action.recommendation,
    expectedOutcome: typeof evidence.expected_outcome === "string" ? evidence.expected_outcome : null,
    priority: action.priority, priorityRationale: action.priorityRationale,
    target: { canonicalUrl: action.targetUrl, connectorIdentity: evidence.target_identity ?? null },
    evidence: sources.map((source) => {
      const brief = source.run.brief && typeof source.run.brief === "object" && !Array.isArray(source.run.brief) ? source.run.brief as Record<string, unknown> : {};
      const meta = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata as Record<string, unknown> : {};
      const ageDays = Math.floor((Date.now() - source.retrievedAt.getTime()) / 86_400_000);
      return { id: source.id, provider: source.provider, url: source.url, title: source.title,
        observedAt: source.publishedAt?.toISOString() ?? source.retrievedAt.toISOString(), retrievedAt: source.retrievedAt.toISOString(),
        coverage: meta.coverage ?? null, market: typeof brief.market === "string" ? brief.market : null,
        language: source.language ?? (typeof brief.language === "string" ? brief.language : null), freshnessDays: ageDays,
        recencyLimitDays: Math.max(1, Math.min(source.run.recencyDays, currentPolicy?.recencyDays ?? source.run.recencyDays, 730)),
        researchPolicyRevision: source.run.policyRevision,
        currentPolicyRevision: currentPolicy?.revision ?? 0 };
    }),
    evidenceComplete: (sourceIds.length > 0 && invalidEvidenceReferences.length === 0 && sources.length === sourceIds.length)
      || technicalEvidenceComplete,
    unavailableEvidenceSourceIds: sourceIds.filter((id) => !sources.some((source) => source.id === id)),
    invalidEvidenceReferences,
    technicalEvidence,
    technicalEvidenceComplete,
    technicalEvidenceStale,
    unavailableTechnicalEvidenceIds: [...new Set(unavailableTechnicalEvidenceIds)],
    invalidTechnicalEvidenceReferences,
    contextRevisions: { businessFacts: context?.revision ?? "0", websiteInventory: context?.revision ?? "0",
      canonicalOrigin: context?.revision ?? "0",
      researchPolicy: (() => {
        const revisions = [...new Set(sources.map((source) => source.run.policyRevision).filter((revision): revision is number => revision !== null))].sort((a, b) => a - b);
        return revisions.length ? revisions[revisions.length - 1] : currentPolicy?.revision ?? 0;
      })(),
      currentResearchPolicy: currentPolicy?.revision ?? 0 },
    requiredCapabilities: action.requiredCapabilities ?? [], acceptanceCriteria: action.acceptanceCriteria ?? [],
    dependencies: action.dependencies ?? [], reassessmentConditions: action.reassessmentConditions ?? [],
    preparationStatus: action.preparationStatus.toLowerCase(),
    preparationRequestId: action.preparationRequestId,
    execution: execution ? { status: execution.status.toLowerCase(), candidateRef: execution.candidateRef,
      reviewUrl: execution.reviewUrl, ownerDecision: execution.ownerDecision, publicationReceipt: execution.publicationReceipt,
      verifiedAt: execution.verifiedAt?.toISOString() ?? null, generation: execution.generation } : null,
  };
}

async function actionRow(actionId: string, projectId: string, siteId?: string) {
  const action = await db.researchAction.findFirst({
    where: { id: actionId, projectId, ...(siteId ? { siteId } : {}) },
    include: { site: { select: { id: true, domain: true } }, finding: { select: { summary: true, evidenceSourceIds: true } } },
  });
  if (!action) throw new ConnectorError("Action not found", 404);
  return action;
}

function inventoryUrls(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) inventoryUrls(item, output);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["url", "canonicalUrl", "targetUrl", "href"]) {
      if (typeof record[key] === "string") {
        try {
          const url = new URL(record[key] as string);
          url.hash = ""; url.search = "";
          output.add(url.toString().replace(/\/$/, "").toLowerCase());
        } catch { /* malformed inventory entries are ignored, never accepted */ }
      }
    }
    for (const child of Object.values(record)) if (child && typeof child === "object") inventoryUrls(child, output);
  }
  return output;
}

function normalizedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.hash = ""; url.search = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch { return null; }
}

export function assertRequiredCapabilities(required: unknown, declared: unknown): void {
  const requiredList = Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
  const declaredList = Array.isArray(declared) ? declared.filter((item): item is string => typeof item === "string") : [];
  const unsupported = requiredList.filter((capability) => !declaredList.includes(capability));
  if (unsupported.length) throw new ConnectorError(`Executor does not support required Action capabilities: ${unsupported.join(", ")}`, 409);
}

const SOURCE_FILE_CAPABILITIES: Record<string, { capability: string; route: string }> = {
  "src/app/robots.ts": { capability: "site_metadata.robots", route: "/robots.txt" },
  "src/app/robots.txt/route.ts": { capability: "site_metadata.robots", route: "/robots.txt" },
  "public/robots.txt": { capability: "site_metadata.robots", route: "/robots.txt" },
  "src/app/sitemap.ts": { capability: "site_metadata.sitemap", route: "/sitemap.xml" },
  "src/app/sitemap.xml/route.ts": { capability: "site_metadata.sitemap", route: "/sitemap.xml" },
  "public/sitemap.xml": { capability: "site_metadata.sitemap", route: "/sitemap.xml" },
};

export function sourceFileTarget(input: {
  targetUrl: string | null; identity: unknown; canonicalOrigin: string;
  declaredCapabilities: unknown; sourceFiles: unknown; requiredCapabilities: unknown;
}): string | null {
  if (!input.identity || typeof input.identity !== "object" || Array.isArray(input.identity)) return null;
  const identity = input.identity as Record<string, unknown>;
  if (identity.kind !== "source_file" || typeof identity.path !== "string") return null;
  const target = SOURCE_FILE_CAPABILITIES[identity.path];
  if (!target) throw new ConnectorError("Source candidate path is outside the exact robots/sitemap allowlist", 409);
  const pathList = Array.isArray(input.sourceFiles) ? input.sourceFiles.filter((item): item is string => typeof item === "string") : [];
  const required = Array.isArray(input.requiredCapabilities) ? input.requiredCapabilities : [];
  const declared = Array.isArray(input.declaredCapabilities) ? input.declaredCapabilities : [];
  if (!pathList.includes(identity.path) || !declared.includes(target.capability) || !required.includes(target.capability)) {
    throw new ConnectorError("Executor has not declared this exact source-file capability", 409);
  }
  let url: URL;
  let origin: URL;
  try {
    url = new URL(input.targetUrl ?? "");
    origin = new URL(input.canonicalOrigin);
  } catch {
    throw new ConnectorError("Source candidate target must match its exact canonical robots/sitemap URL", 409);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash
      || url.origin !== origin.origin || url.pathname !== target.route) {
    throw new ConnectorError("Source candidate target must match its exact canonical robots/sitemap URL", 409);
  }
  return identity.path;
}

type PreparationEvidenceSource = { id: string; retrievedAt: Date; run: { recencyDays: number } };

export function assertPreparationEvidenceSources(
  requestedIds: string[], sources: PreparationEvidenceSource[], currentRecencyDays: number | null, now = Date.now(),
): void {
  if (!requestedIds.length) throw new ConnectorError("Action has no linked evidence sources", 409);
  const byId = new Map(sources.map((source) => [source.id, source]));
  if (byId.size !== requestedIds.length || requestedIds.some((id) => !byId.has(id))) {
    throw new ConnectorError("One or more Action evidence sources are no longer available", 409);
  }
  for (const id of requestedIds) {
    const source = byId.get(id)!;
    const ageMs = now - source.retrievedAt.getTime();
    if (ageMs < -5 * 60_000) throw new ConnectorError("Action evidence has an invalid future retrieval time", 409);
    const limits = [source.run.recencyDays, currentRecencyDays].filter((value): value is number => value !== null);
    const limitDays = Math.max(1, Math.min(...limits, 730));
    if (ageMs > limitDays * 86_400_000) throw new ConnectorError("Action evidence is stale and must be reassessed", 409);
  }
}

function evidenceIds(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim())) {
    throw new ConnectorError(`${label} contains invalid evidence source IDs`, 409);
  }
  return value;
}

function envelopeEvidenceIds(value: unknown): { ids: string[]; invalid: boolean; invalidIds: string[] } {
  if (value === undefined || value === null) return { ids: [], invalid: false, invalidIds: [] };
  if (!Array.isArray(value)) return { ids: [], invalid: true, invalidIds: ["invalid-evidence-reference"] };
  const ids: string[] = [];
  const invalidIds: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
      invalidIds.push(typeof id === "string" ? id : "invalid-evidence-reference");
      continue;
    }
    ids.push(id);
  }
  return { ids, invalid: invalidIds.length > 0, invalidIds };
}

async function assertPreparationEvidence(tx: Prisma.TransactionClient, action: {
  siteId: string; targetUrl: string | null; evidence: Prisma.JsonValue | null; acceptanceCriteria: Prisma.JsonValue | null;
  requiredCapabilities: Prisma.JsonValue | null;
  finding: { evidenceSourceIds: Prisma.JsonValue | null } | null;
}, projectId: string) {
  const context = await tx.connectorContextSnapshot.findFirst({ where: { projectId, siteId: action.siteId } });
  if (!context) throw new ConnectorError("Current connector inventory and business context are required before preparation", 409);
  const ageMs = Date.now() - context.observedAt.getTime();
  if (ageMs < -5 * 60_000 || ageMs > 7 * 86_400_000) throw new ConnectorError("Connector context is stale; refresh inventory before preparation", 409);
  const capabilities = context.capabilities && typeof context.capabilities === "object" && !Array.isArray(context.capabilities)
    ? context.capabilities as Record<string, unknown> : {};
  const declared = Array.isArray(capabilities.supported) ? capabilities.supported.filter((item): item is string => typeof item === "string") : [];
  assertRequiredCapabilities(action.requiredCapabilities, declared);
  const actionEvidence = action.evidence && typeof action.evidence === "object" && !Array.isArray(action.evidence)
    ? action.evidence as Record<string, unknown> : {};
  const sourcePath = sourceFileTarget({ targetUrl: action.targetUrl,
    identity: actionEvidence.target_identity, canonicalOrigin: context.canonicalOrigin,
    declaredCapabilities: declared, sourceFiles: capabilities.sourceFiles,
    requiredCapabilities: action.requiredCapabilities });
  if (action.targetUrl) {
    const url = normalizedUrl(action.targetUrl);
    const origin = normalizedUrl(context.canonicalOrigin);
    if (!url || !origin || !(url === origin || url.startsWith(`${origin}/`))) throw new ConnectorError("Action target is outside the canonical site origin", 409);
    if (!sourcePath && !inventoryUrls(context.websiteInventory).has(url)) throw new ConnectorError("Action target is not present in the current website inventory", 409);
  } else {
    if (!declared.some((item) => item === "content.create" || item === "article.create")) throw new ConnectorError("Action has no target and the connector has not declared a bounded content creation capability", 409);
    if (!action.acceptanceCriteria || !Array.isArray(action.acceptanceCriteria) || action.acceptanceCriteria.length === 0) throw new ConnectorError("Targetless preparation requires explicit acceptance criteria", 409);
  }
  const evidence = action.evidence && typeof action.evidence === "object" && !Array.isArray(action.evidence)
    ? action.evidence as Record<string, unknown> : {};
  const sourceIds = [...new Set([...evidenceIds(action.finding?.evidenceSourceIds, "Finding"), ...evidenceIds(evidence.source_ids, "Action")])];
  const [sources, policy] = await Promise.all([
    tx.researchSource.findMany({ where: { id: { in: sourceIds }, run: { projectId, siteId: action.siteId } },
      select: { id: true, retrievedAt: true, run: { select: { recencyDays: true } } } }),
    tx.researchPolicy.findUnique({ where: { siteId: action.siteId }, select: { recencyDays: true } }),
  ]);
  assertPreparationEvidenceSources(sourceIds, sources, policy?.recencyDays ?? null);
}

export async function listConnectorActions(principal: ServicePrincipalContext, options: { siteId: string; since?: string; cursor?: string; limit: number }) {
  const site = await activeSite(principal.projectId, options.siteId);
  let since: string | null = null;
  if (options.since) {
    const parsedSince = new Date(options.since);
    if (Number.isNaN(parsedSince.getTime())) throw new ConnectorError("Action since timestamp is invalid");
    since = parsedSince.toISOString();
  }
  let cursor: { projectId: string; siteId: string; since: string | null; id: string; updatedAt: Date } | undefined;
  if (options.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (parsed.projectId !== principal.projectId || parsed.siteId !== site.id || parsed.since !== since || typeof parsed.id !== "string"
          || typeof parsed.updatedAt !== "string" || Number.isNaN(Date.parse(parsed.updatedAt))) throw new Error();
      cursor = { projectId: parsed.projectId, siteId: parsed.siteId, since: parsed.since, id: parsed.id, updatedAt: new Date(parsed.updatedAt) };
    } catch { throw new ConnectorError("Action cursor is invalid"); }
  }
  const actions = await db.researchAction.findMany({ where: { projectId: principal.projectId, siteId: site.id,
      ...(since ? { updatedAt: { gt: new Date(since) } } : {}),
      ...(cursor ? { OR: [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: cursor.id } }] } : {}) },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: options.limit + 1,
    select: { id: true }, });
  const hasMore = actions.length > options.limit;
  const page = actions.slice(0, options.limit);
  return { actions: await Promise.all(page.map(async ({ id }) => envelope(await actionRow(id, principal.projectId)))),
    nextCursor: hasMore && page.length ? Buffer.from(JSON.stringify({ projectId: principal.projectId, siteId: site.id, since, id: page.at(-1)!.id,
      updatedAt: (await db.researchAction.findUniqueOrThrow({ where: { id: page.at(-1)!.id }, select: { updatedAt: true } })).updatedAt.toISOString() })).toString("base64url") : null };
}

export async function listConnectorFindings(principal: ServicePrincipalContext, options: {
  siteId: string; runId?: string; since?: string; cursor?: string; limit: number;
}) {
  const site = await activeSite(principal.projectId, options.siteId);
  let since: string | null = null;
  if (options.since) {
    const parsedSince = new Date(options.since);
    if (Number.isNaN(parsedSince.getTime())) throw new ConnectorError("Finding since timestamp is invalid");
    since = parsedSince.toISOString();
  }
  let cursor: { projectId: string; siteId: string; runId: string | null; since: string | null; id: string; createdAt: Date } | undefined;
  if (options.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (parsed.projectId !== principal.projectId || parsed.siteId !== site.id || parsed.runId !== (options.runId ?? null)
          || parsed.since !== since || typeof parsed.id !== "string" || typeof parsed.createdAt !== "string"
          || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
      cursor = { projectId: parsed.projectId, siteId: parsed.siteId, runId: parsed.runId, since: parsed.since,
        id: parsed.id, createdAt: new Date(parsed.createdAt) };
    } catch { throw new ConnectorError("Finding cursor is invalid"); }
  }
  const findings = await db.researchFinding.findMany({
    where: { run: { projectId: principal.projectId, siteId: site.id, ...(options.runId ? { id: options.runId } : {}) },
      ...(since ? { createdAt: { gt: new Date(since) } } : {}),
      ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: options.limit + 1,
    select: { id: true, runId: true, type: true, theme: true, summary: true, confidence: true, sentiment: true,
      urgency: true, evidenceSourceIds: true, suggestedActionKind: true, createdAt: true,
      run: { select: { policyRevision: true, recencyDays: true, brief: true } } },
  });
  const hasMore = findings.length > options.limit;
  const page = findings.slice(0, options.limit);
  const ids = [...new Set(page.flatMap((finding) => envelopeEvidenceIds(finding.evidenceSourceIds).ids))];
  const [sources, linkedActions, currentPolicy] = await Promise.all([
    db.researchSource.findMany({
      where: { id: { in: ids }, run: { projectId: principal.projectId, siteId: site.id } },
      select: { id: true, runId: true, provider: true, url: true, title: true,
        publishedAt: true, retrievedAt: true, language: true, metadata: true,
        run: { select: { policyRevision: true, recencyDays: true, brief: true } } },
    }),
    page.length ? db.researchAction.findMany({
      where: { projectId: principal.projectId, siteId: site.id, findingId: { in: page.map((finding) => finding.id) } },
      select: { id: true, revision: true, findingId: true },
    }) : Promise.resolve([]),
    db.researchPolicy.findUnique({ where: { siteId: site.id }, select: { revision: true, recencyDays: true } }),
  ]);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const actionsByFinding = new Map<string, Array<{ id: string; revision: number }>>();
  for (const action of linkedActions) {
    if (!action.findingId) continue;
    const rows = actionsByFinding.get(action.findingId) ?? [];
    rows.push({ id: action.id, revision: action.revision });
    actionsByFinding.set(action.findingId, rows);
  }
  const result = page.map((finding) => {
    const refs = envelopeEvidenceIds(finding.evidenceSourceIds);
    const uniqueIds = [...new Set(refs.ids)];
    const invalidReferences = refs.invalid || uniqueIds.length !== refs.ids.length;
    const brief = finding.run.brief && typeof finding.run.brief === "object" && !Array.isArray(finding.run.brief)
      ? finding.run.brief as Record<string, unknown> : {};
    const evidence = uniqueIds.flatMap((id) => {
      const source = sourceById.get(id);
      if (!source || source.runId !== finding.runId) return [];
      const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
        ? source.metadata as Record<string, unknown> : {};
      const coverage = metadata.coverage;
      const boundedCoverage = typeof coverage === "string" ? coverage.slice(0, 240)
        : typeof coverage === "number" || typeof coverage === "boolean" ? coverage : null;
      const ageDays = Math.floor((Date.now() - source.retrievedAt.getTime()) / 86_400_000);
      const recencyLimitDays = Math.max(1, Math.min(source.run.recencyDays, currentPolicy?.recencyDays ?? source.run.recencyDays, 730));
      return [{ id: source.id, provider: source.provider.slice(0, 80), url: source.url.slice(0, 2000),
        title: source.title?.slice(0, 500) ?? null,
        observedAt: source.publishedAt?.toISOString() ?? source.retrievedAt.toISOString(),
        publishedAt: source.publishedAt?.toISOString() ?? null, retrievedAt: source.retrievedAt.toISOString(),
        language: source.language ?? (typeof brief.language === "string" ? brief.language : null),
        market: typeof brief.market === "string" ? brief.market.slice(0, 120) : null, coverage: boundedCoverage,
        freshnessDays: ageDays, recencyLimitDays, researchPolicyRevision: source.run.policyRevision,
        currentPolicyRevision: currentPolicy?.revision ?? 0 }];
    });
    return { id: finding.id, runId: finding.runId, type: finding.type, theme: finding.theme, summary: finding.summary,
      confidence: finding.confidence, sentiment: finding.sentiment, urgency: finding.urgency,
      suggestedActionKind: finding.suggestedActionKind, createdAt: finding.createdAt.toISOString(),
      researchPolicyRevision: finding.run.policyRevision, currentPolicyRevision: currentPolicy?.revision ?? 0,
      recencyDays: finding.run.recencyDays,
      actionRefs: actionsByFinding.get(finding.id) ?? [],
      evidence, evidenceComplete: uniqueIds.length > 0 && !invalidReferences && evidence.length === uniqueIds.length,
      unavailableEvidenceSourceIds: uniqueIds.filter((id) => !evidence.some((source) => source.id === id)),
      invalidEvidenceReferences: invalidReferences };
  });
  const last = page.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ projectId: principal.projectId, siteId: site.id,
    runId: options.runId ?? null, since, id: last.id, createdAt: last.createdAt.toISOString() })).toString("base64url") : null;
  return { schemaVersion: "1.0", projectId: principal.projectId, siteId: site.id, findings: result, nextCursor };
}

export async function getConnectorAction(principal: ServicePrincipalContext, actionId: string, siteId?: string) {
  return envelope(await actionRow(actionId, principal.projectId, siteId));
}

export async function operateOnAction(principal: ServicePrincipalContext, input: {
  actionId: string; operation: "accept_preparation" | "decline_preparation" | "request_correction" | "cancel_preparation";
  expectedRevision: number; generation: number; idempotencyKey: string; rationale?: string;
}) {
  const initialAction = await actionRow(input.actionId, principal.projectId);
  const site = await activeSite(principal.projectId, initialAction.siteId);
  assertExecutionAdapter(site.connectorBinding);
  const requestHash = sha({ actionId: input.actionId, operation: input.operation, expectedRevision: input.expectedRevision, generation: input.generation, rationale: input.rationale ?? null });
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ConnectorBinding" WHERE "siteId" = ${site.id} FOR UPDATE`;
      const binding = await tx.connectorBinding.findUnique({ where: { siteId: site.id } });
      if (!binding || binding.status !== "ACTIVE" || binding.projectId !== principal.projectId || binding.generation !== input.generation) throw new ConnectorError("Connector binding is stale or inactive", 409);
      assertExecutionAdapter(binding);
      const prior = await tx.connectorOperationReceipt.findUnique({ where: { projectId_operation_idempotencyKey: { projectId: principal.projectId, operation: input.operation, idempotencyKey: input.idempotencyKey } } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ConnectorError("Idempotency key was already used for a different request", 409);
        return prior.result;
      }
      const action = await tx.researchAction.findFirst({ where: { id: input.actionId, projectId: principal.projectId, siteId: site.id },
        include: { finding: { select: { evidenceSourceIds: true } } } });
      if (!action) throw new ConnectorError("Action not found", 404);
      if (action.revision !== input.expectedRevision) throw new ConnectorError("Action revision changed; refresh before retrying", 409);
      if (input.operation === "accept_preparation" && ["DISMISSED", "VERIFIED", "FAILED"].includes(action.status)) throw new ConnectorError("Terminal Actions cannot be prepared", 409);
      const execution = await tx.connectorExecutionState.findUnique({ where: { actionId_actionRevision: { actionId: action.id, actionRevision: action.revision } }, select: { ownerDecision: true, status: true } });
      if (execution?.ownerDecision) throw new ConnectorError("An Action with a recorded owner decision cannot be changed", 409);
      if (input.operation === "accept_preparation" && action.preparationStatus === "CANCELLED") throw new ConnectorError("A cancelled Action revision must be reassessed before preparation", 409);
      if (input.operation === "accept_preparation" && !["NONE", "ELIGIBLE", "BLOCKED"].includes(action.preparationStatus)) {
        throw new ConnectorError("Preparation can only start from an unstarted or blocked state", 409);
      }
      if (["cancel_preparation", "decline_preparation", "request_correction"].includes(input.operation)
          && execution?.status === "preparation_ready") {
        // The HelloAda candidate is an exact owner review. Keep all changes to
        // that candidate on its existing correction/decline surface.
        if (input.operation === "request_correction") throw new ConnectorError("A ready candidate must be corrected through its authenticated HelloAda review", 409);
      }
      if (input.operation === "accept_preparation") await assertPreparationEvidence(tx, action, principal.projectId);
      const preparationStatus = input.operation === "accept_preparation" ? "QUEUED"
        : input.operation === "decline_preparation" || input.operation === "cancel_preparation" || input.operation === "request_correction" ? "CANCELLED" : action.preparationStatus;
      if (input.operation !== "request_correction" || action.preparationStatus !== "CANCELLED") {
      await tx.researchAction.update({ where: { id: action.id }, data: { preparationStatus,
        preparationRequestId: input.operation === "accept_preparation" ? input.idempotencyKey : null } });
      }
      const eventType = input.operation === "accept_preparation" ? "preparation.requested"
        : input.operation === "decline_preparation" ? "preparation.declined"
          : input.operation === "cancel_preparation" ? "preparation.cancel_requested" : "preparation.correction_requested";
      const payload = { operation: input.operation, rationale: input.rationale ?? null, generation: binding.generation,
        ...(input.operation === "accept_preparation" ? { preparationRequestId: input.idempotencyKey } : {}) };
      await emitConnectorEvent(tx, { projectId: principal.projectId, siteId: site.id, actionId: action.id, actionRevision: action.revision, type: eventType, payload });
      const result = { actionId: action.id, revision: action.revision, operation: input.operation, preparationStatus: preparationStatus.toLowerCase(), accepted: true };
      await tx.connectorOperationReceipt.create({ data: { projectId: principal.projectId, siteId: site.id, actionId: action.id,
        actionRevision: action.revision, operation: input.operation, idempotencyKey: input.idempotencyKey, requestHash, result: json(result) } });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if ((error as { code?: string }).code === "P2002" || (error as { code?: string }).code === "P2034") throw new ConnectorError("Action operation raced another request; refresh and retry with a new idempotency key", 409);
    throw error;
  }
}

export async function recordExecutionStatus(principal: ServicePrincipalContext, input: {
  actionId: string; actionRevision: number; generation: number; idempotencyKey: string;
  status: "preparation_blocked" | "preparation_ready" | "owner_decision" | "publication_verified" | "outcome_measured";
  preparationRequestId?: string; candidateRef?: string; reviewUrl?: string; ownerDecision?: "approved" | "declined"; publicationReceipt?: unknown; detail?: unknown;
}) {
  const action = await actionRow(input.actionId, principal.projectId);
  const site = await activeSite(principal.projectId, action.siteId);
  assertExecutionAdapter(site.connectorBinding);
  if (input.reviewUrl) {
    const context = await db.connectorContextSnapshot.findFirst({ where: { projectId: principal.projectId, siteId: site.id }, select: { capabilities: true } });
    const capabilities = context?.capabilities && typeof context.capabilities === "object" && !Array.isArray(context.capabilities)
      ? context.capabilities as Record<string, unknown> : {};
    const expectedReviewOrigin = typeof capabilities.reviewOrigin === "string" ? capabilities.reviewOrigin : "";
    let reviewOrigin = "";
    try { reviewOrigin = new URL(input.reviewUrl).origin; } catch { /* schema validates URL; keep fail closed */ }
    if (!expectedReviewOrigin || reviewOrigin !== expectedReviewOrigin) throw new ConnectorError("Review reference must use the registered authenticated owner workspace", 400);
  }
  const idempotencyKey = `status:${input.idempotencyKey}`;
  const requestHash = sha(input);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ConnectorBinding" WHERE "siteId" = ${site.id} FOR UPDATE`;
      const binding = await tx.connectorBinding.findUnique({ where: { siteId: site.id } });
      if (!binding || binding.status !== "ACTIVE" || binding.projectId !== principal.projectId || binding.generation !== input.generation) throw new ConnectorError("Connector binding is stale or inactive", 409);
      assertExecutionAdapter(binding);
      const prior = await tx.connectorOperationReceipt.findUnique({ where: { projectId_operation_idempotencyKey: { projectId: principal.projectId, operation: input.status, idempotencyKey } } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ConnectorError("Status event ID was reused with different data", 409);
        return prior.result;
      }
      const currentAction = await tx.researchAction.findFirst({ where: { id: action.id, projectId: principal.projectId, siteId: site.id },
        select: { revision: true, preparationStatus: true, preparationRequestId: true } });
      if (!currentAction || currentAction.revision !== input.actionRevision) throw new ConnectorError("Action revision changed during status recording", 409);
      const current = await tx.connectorExecutionState.findUnique({ where: { actionId_actionRevision: { actionId: action.id, actionRevision: action.revision } } });
      if (current?.status === "publication_verified" && input.status === "publication_verified") {
        const priorReceipt = current.publicationReceipt && typeof current.publicationReceipt === "object"
          ? current.publicationReceipt as Record<string, unknown> : {};
        const nextReceipt = input.publicationReceipt && typeof input.publicationReceipt === "object"
          ? input.publicationReceipt as Record<string, unknown> : {};
        if (sha(priorReceipt) !== sha(nextReceipt)) throw new ConnectorError("A verified publication receipt cannot be replaced", 409);
        throw new ConnectorError("Publication is already verified for this Action revision", 409);
      }
      if (current?.status === "outcome_measured") throw new ConnectorError("Outcome is already measured for this Action revision", 409);
      if (current?.status === "publication_verified" && input.status !== "outcome_measured") throw new ConnectorError("Verified publication state is terminal", 409);
      if (["preparation_blocked", "preparation_ready"].includes(input.status) && current?.ownerDecision) throw new ConnectorError("Preparation cannot change after an owner decision", 409);
      if (input.status === "preparation_blocked" && (current?.status === "preparation_ready" || currentAction.preparationStatus === "CANCELLED")) throw new ConnectorError("A stale preparation failure cannot replace a ready or cancelled Action", 409);
      if (current?.ownerDecision && input.status === "owner_decision") {
        if (current.ownerDecision !== input.ownerDecision) throw new ConnectorError("An owner decision cannot be reversed for the same Action revision", 409);
        throw new ConnectorError("An owner decision is already recorded for this Action revision", 409);
      }
      if (current?.status === "preparation_ready" && input.status === "preparation_ready"
          && (current.candidateRef !== input.candidateRef || current.reviewUrl !== input.reviewUrl)) {
        throw new ConnectorError("A ready Action candidate and review reference cannot be replaced without a new Action revision", 409);
      }
      if (input.status === "preparation_ready" && currentAction.preparationStatus !== "QUEUED") throw new ConnectorError("Preparation readiness requires a current queued request", 409);
      if (["preparation_blocked", "preparation_ready"].includes(input.status)
          && (!input.preparationRequestId || input.preparationRequestId !== currentAction.preparationRequestId)) {
        throw new ConnectorError("Preparation report does not match the current accepted attempt", 409);
      }
      if (input.status === "owner_decision" && current?.status !== "preparation_ready") throw new ConnectorError("Owner decision requires a ready exact candidate", 409);
      if (input.status === "owner_decision" && currentAction.preparationStatus !== "READY") throw new ConnectorError("Owner decision requires the Action preparation to remain ready", 409);
      if (input.status === "publication_verified" && current?.status !== "owner_decision") throw new ConnectorError("Publication requires a recorded exact owner decision", 409);
      if (input.status === "outcome_measured" && current?.status !== "publication_verified") throw new ConnectorError("Outcome requires verified publication", 409);
      if (input.status === "publication_verified" && current?.ownerDecision !== "approved") throw new ConnectorError("Only an exactly approved owner candidate can be reported published", 409);
      if (input.status === "publication_verified") {
        const receipt = input.publicationReceipt && typeof input.publicationReceipt === "object" && !Array.isArray(input.publicationReceipt)
          ? input.publicationReceipt as Record<string, unknown> : {};
        const publishedAt = typeof receipt.publishedAt === "string" ? receipt.publishedAt : "";
        if (receipt.candidateRef !== current?.candidateRef || typeof receipt.receiptId !== "string" || !receipt.receiptId.trim()
          || typeof receipt.targetUrl !== "string" || !normalizedUrl(receipt.targetUrl)
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(publishedAt)
          || Number.isNaN(Date.parse(publishedAt))
          || typeof receipt.contentHash !== "string" || !/^[a-f0-9]{32,128}$/i.test(receipt.contentHash)) {
          throw new ConnectorError("Publication receipt must identify the exact approved candidate, target, time, and content hash", 400);
        }
        if (action.targetUrl && normalizedUrl(receipt.targetUrl) !== normalizedUrl(action.targetUrl)) throw new ConnectorError("Publication receipt target does not match the Action target", 409);
        const targetUrl = normalizedUrl(receipt.targetUrl);
        const canonicalOrigin = normalizedUrl(`https://${site.domain}/`);
        if (!targetUrl || !canonicalOrigin || !(targetUrl === canonicalOrigin || targetUrl.startsWith(`${canonicalOrigin}/`))) {
          throw new ConnectorError("Publication receipt target is outside the registered canonical site", 409);
        }
      }
      if (input.status === "outcome_measured" && !current?.publicationReceipt) throw new ConnectorError("Outcome cannot precede verified publication", 409);
      if (input.status === "owner_decision" && (!input.ownerDecision || !input.candidateRef || !input.reviewUrl)) throw new ConnectorError("Owner decision must identify the exact candidate and authenticated review", 400);
      if (input.status === "owner_decision" && current?.candidateRef !== input.candidateRef) throw new ConnectorError("Owner decision does not match the ready candidate", 409);
      if (input.status === "owner_decision" && current?.reviewUrl !== input.reviewUrl) throw new ConnectorError("Owner decision review does not match the ready candidate", 409);
      const reportDetail = input.detail && typeof input.detail === "object" && !Array.isArray(input.detail)
        ? input.detail as Record<string, unknown> : {};
      const reviewPackageHash = typeof reportDetail.reviewPackageHash === "string" ? reportDetail.reviewPackageHash : "";
      if (input.status === "preparation_ready" && !/^[a-f0-9]{64}$/i.test(reviewPackageHash)) {
        throw new ConnectorError("Ready preparation must identify its exact review package hash", 400);
      }
      if (input.status === "owner_decision" && (!/^[a-f0-9]{64}$/i.test(reviewPackageHash)
          || current?.reviewPackageHash !== reviewPackageHash)) {
        throw new ConnectorError("Owner decision does not match the ready review package", 409);
      }
      if (input.status === "publication_verified" && current?.reviewPackageHash
          && reviewPackageHash !== current.reviewPackageHash) {
        throw new ConnectorError("Publication does not match the approved review package", 409);
      }
      if (input.status === "preparation_ready" && (!input.candidateRef || !input.reviewUrl)) throw new ConnectorError("Ready preparation must identify its candidate and review", 400);
      if (input.status === "preparation_ready" && current?.status === "preparation_ready" && current.candidateRef !== input.candidateRef) throw new ConnectorError("A ready Action candidate cannot be replaced without a new Action revision", 409);
      const status = input.status;
      const resultData = { projectId: principal.projectId, siteId: site.id, actionId: action.id, actionRevision: action.revision,
        generation: binding.generation, status, candidateRef: input.candidateRef ?? current?.candidateRef ?? null,
        reviewUrl: input.reviewUrl ?? current?.reviewUrl ?? null,
        reviewPackageHash: input.status === "preparation_ready" ? reviewPackageHash : current?.reviewPackageHash ?? null,
        ownerDecision: input.status === "owner_decision" ? input.ownerDecision : current?.ownerDecision ?? null,
        publicationReceipt: input.status === "publication_verified" ? json(input.publicationReceipt) : current?.publicationReceipt ?? undefined,
        verifiedAt: input.status === "publication_verified" ? new Date() : current?.verifiedAt ?? null,
        observedAt: new Date() };
      const saved = await tx.connectorExecutionState.upsert({ where: { actionId_actionRevision: { actionId: action.id, actionRevision: action.revision } },
        create: resultData, update: resultData });
      const eventType = `execution.${input.status}`;
      await emitConnectorEvent(tx, { projectId: principal.projectId, siteId: site.id, actionId: action.id, actionRevision: action.revision,
        type: eventType, payload: { status: input.status, generation: binding.generation, candidateRef: saved.candidateRef,
          reviewUrl: saved.reviewUrl, ownerDecision: saved.ownerDecision, publicationReceipt: input.publicationReceipt ?? null, detail: input.detail ?? null } });
      if (input.status === "preparation_ready") await tx.researchAction.update({ where: { id: action.id }, data: { preparationStatus: "READY" } });
      if (input.status === "preparation_blocked") await tx.researchAction.update({ where: { id: action.id }, data: { preparationStatus: "BLOCKED" } });
      if (input.status === "owner_decision") await tx.researchAction.update({ where: { id: action.id }, data: { preparationStatus: input.ownerDecision === "declined" ? "CANCELLED" : action.preparationStatus } });
      const result = { actionId: action.id, revision: action.revision, status: input.status, recorded: true };
      await tx.connectorOperationReceipt.create({ data: { projectId: principal.projectId, siteId: site.id, actionId: action.id,
        actionRevision: action.revision, operation: input.status, idempotencyKey, requestHash, result: json(result) } });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if ((error as { code?: string }).code === "P2002" || (error as { code?: string }).code === "P2034") throw new ConnectorError("Status event raced another request; reconcile before retrying", 409);
    throw error;
  }
}

export async function pollConnectorEvents(principal: ServicePrincipalContext, after: number, limit: number, siteId: string) {
  const site = await activeSite(principal.projectId, siteId);
  // Unacknowledged events remain a durable queue. The consumer cursor is only
  // advisory: after a gap or restart, polling must return every due receipt.
  void after;
  return db.connectorEvent.findMany({ where: { projectId: principal.projectId, siteId: site.id, acknowledgedAt: null, nextAttemptAt: { lte: new Date() } },
    orderBy: { sequence: "asc" }, take: limit, select: { id: true, sequence: true, siteId: true, actionId: true,
      actionRevision: true, type: true, payload: true, occurredAt: true } });
}

export async function acknowledgeConnectorEvents(principal: ServicePrincipalContext, ids: string[], siteId: string) {
  const site = await activeSite(principal.projectId, siteId);
  if (!ids.length) return { acknowledged: 0, receivedAt: new Date().toISOString() };
  const now = new Date();
  const result = await db.connectorEvent.updateMany({ where: { projectId: principal.projectId, siteId: site.id, id: { in: ids }, acknowledgedAt: null }, data: { acknowledgedAt: now } });
  return { acknowledged: result.count, receivedAt: now.toISOString() };
}

export async function reportConnectorEventFailure(principal: ServicePrincipalContext, id: string, message: string, siteId: string) {
  const site = await activeSite(principal.projectId, siteId);
  const event = await db.connectorEvent.findFirst({ where: { id, projectId: principal.projectId, siteId: site.id, acknowledgedAt: null } });
  if (!event) return { accepted: false };
  const attempts = event.attempts + 1;
  const delaySeconds = Math.min(3600, 15 * 2 ** Math.min(attempts - 1, 8));
  const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000);
  const updated = await db.connectorEvent.updateMany({ where: { id, projectId: principal.projectId, siteId: site.id, acknowledgedAt: null, attempts: event.attempts },
    data: { attempts, nextAttemptAt, lastError: safeFailure(message) } });
  if (updated.count !== 1) return { accepted: false };
  return { accepted: true, nextAttemptAt: nextAttemptAt.toISOString() };
}

function periodInTimeZone(timeZone: string, now = new Date()): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  } catch { throw new ConnectorError("Research budget timezone is invalid", 409); }
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new ConnectorError("Research budget period could not be calculated", 500);
  return `${year}-${month}`;
}

export async function connectorBudget(principal: ServicePrincipalContext, siteId: string) {
  const site = await activeSite(principal.projectId, siteId);
  const project = await db.project.findUnique({ where: { id: principal.projectId }, select: {
    monthlyResearchAllowanceMicros: true, maxResearchOperationMicros: true, researchBudgetCurrency: true,
    researchBudgetTimeZone: true, researchBudgetRevision: true,
  } });
  if (!project) throw new ConnectorError("Project not found", 404);
  const period = periodInTimeZone(project.researchBudgetTimeZone);
  const rows = await db.researchBudgetReservation.findMany({ where: { projectId: principal.projectId, period },
    select: { status: true, amountMicros: true, actualCostMicros: true, currency: true } });
  let committed = BigInt(0);
  let reserved = BigInt(0);
  for (const row of rows) {
    const amount = row.status === "SETTLED" ? row.actualCostMicros ?? row.amountMicros : row.amountMicros;
    if (row.status === "RESERVED" || row.status === "UNCERTAIN") reserved += row.amountMicros;
    if (["RESERVED", "UNCERTAIN", "SETTLED"].includes(row.status)) committed += amount;
  }
  const allowance = project.monthlyResearchAllowanceMicros;
  return { projectId: principal.projectId, siteId: site.id, policyRevision: project.researchBudgetRevision,
    period, timeZone: project.researchBudgetTimeZone, currency: project.researchBudgetCurrency,
    allowanceMicros: allowance?.toString() ?? null, committedMicros: committed.toString(), reservedMicros: reserved.toString(),
    remainingMicros: allowance === null ? null : (allowance - committed).toString(), configured: allowance !== null,
    maxOperationMicros: project.maxResearchOperationMicros?.toString() ?? null };
}

export async function updateConnectorBudgetPolicy(principal: ServicePrincipalContext, input: {
  siteId: string; expectedRevision: number | null; monthlyAllowanceMicros: string | null; maxOperationMicros?: string | null; currency: string; timeZone: string;
}) {
  const site = await activeSite(principal.projectId, input.siteId);
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(new Date()); }
  catch { throw new ConnectorError("Research budget timezone is invalid"); }
  const allowance = input.monthlyAllowanceMicros === null ? null : BigInt(input.monthlyAllowanceMicros);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${principal.projectId} FOR UPDATE`;
      const previous = await tx.project.findUnique({ where: { id: principal.projectId }, select: {
        monthlyResearchAllowanceMicros: true, maxResearchOperationMicros: true, researchBudgetCurrency: true,
        researchBudgetTimeZone: true, researchBudgetRevision: true,
      } });
      if (!previous || previous.researchBudgetRevision !== input.expectedRevision) throw new ConnectorError("Research budget policy changed; refresh before retrying", 409);
      const maxOperation = input.maxOperationMicros === undefined ? previous.maxResearchOperationMicros
        : input.maxOperationMicros === null ? null : BigInt(input.maxOperationMicros);
      if (maxOperation !== null && (allowance === null || maxOperation > allowance)) {
        throw new ConnectorError("Per-operation ceiling must be configured with and fit within the monthly allowance", 400);
      }
      if (previous.researchBudgetCurrency !== input.currency || previous.researchBudgetTimeZone !== input.timeZone) {
        const period = periodInTimeZone(previous.researchBudgetTimeZone);
        const existing = await tx.researchBudgetReservation.count({ where: { projectId: principal.projectId, period } });
        if (existing > 0) throw new ConnectorError("Currency or timezone cannot change while this period has budget reservations", 409);
      }
      const updated = await tx.project.update({ where: { id: principal.projectId }, data: {
        monthlyResearchAllowanceMicros: allowance, maxResearchOperationMicros: maxOperation, researchBudgetCurrency: input.currency,
        researchBudgetTimeZone: input.timeZone, researchBudgetRevision: { increment: 1 },
      }, select: { monthlyResearchAllowanceMicros: true, maxResearchOperationMicros: true, researchBudgetCurrency: true,
        researchBudgetTimeZone: true, researchBudgetRevision: true } });
      return { projectId: principal.projectId, siteId: site.id, policyRevision: updated.researchBudgetRevision,
        monthlyAllowanceMicros: updated.monthlyResearchAllowanceMicros?.toString() ?? null,
        maxOperationMicros: updated.maxResearchOperationMicros?.toString() ?? null,
        currency: updated.researchBudgetCurrency, timeZone: updated.researchBudgetTimeZone };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if ((error as { code?: string }).code === "P2034") throw new ConnectorError("Research budget policy changed concurrently; refresh before retrying", 409);
    throw error;
  }
}

export async function reserveConnectorBudget(principal: ServicePrincipalContext, input: {
  siteId: string; period: string; policyRevision: number; idempotencyKey: string;
  amountMicros: string; currency: string; operation: string; detail?: unknown;
}) {
  const site = await activeSite(principal.projectId, input.siteId);
  const amount = BigInt(input.amountMicros);
  const requestHash = budgetFingerprint({ projectId: principal.projectId, siteId: site.id, period: input.period,
    policyRevision: input.policyRevision, amountMicros: input.amountMicros, currency: input.currency,
    operation: input.operation, detail: input.detail ?? null });
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${principal.projectId} FOR UPDATE`;
      const policy = await tx.project.findUnique({ where: { id: principal.projectId }, select: {
        monthlyResearchAllowanceMicros: true, maxResearchOperationMicros: true, researchBudgetCurrency: true,
        researchBudgetTimeZone: true, researchBudgetRevision: true,
      } });
      const prior = await tx.researchBudgetReservation.findUnique({ where: { projectId_idempotencyKey: { projectId: principal.projectId, idempotencyKey: input.idempotencyKey } } });
      if (prior) {
        const priorHash = budgetFingerprint({ projectId: principal.projectId, siteId: prior.siteId, period: prior.period,
          policyRevision: prior.policyRevision, amountMicros: prior.amountMicros.toString(), currency: prior.currency,
          operation: prior.operation, detail: prior.detail ?? null });
        if (priorHash !== requestHash || prior.siteId !== site.id) throw new ConnectorError("Budget idempotency key was reused for different work", 409);
        if (prior.status !== "RELEASED") return prior;
        throw new ConnectorError("A released budget idempotency key cannot be reused for a new dispatch", 409);
      }
      if (!policy || policy.monthlyResearchAllowanceMicros === null) throw new ConnectorError("Monetary research allowance is not configured", 409);
      if (policy.maxResearchOperationMicros === null || amount > policy.maxResearchOperationMicros) throw new ConnectorError("Research reservation exceeds the configured per-operation ceiling", 429);
      if (policy.researchBudgetRevision !== input.policyRevision) throw new ConnectorError("Research budget policy changed; refresh before reserving", 409);
      if (policy.researchBudgetCurrency.toUpperCase() !== input.currency) throw new ConnectorError("Research reservation currency does not match policy", 409);
      if (periodInTimeZone(policy.researchBudgetTimeZone) !== input.period) throw new ConnectorError("Research reservation period is not current in the policy timezone", 409);
      const rows = await tx.researchBudgetReservation.findMany({ where: { projectId: principal.projectId, period: input.period,
        status: { in: ["RESERVED", "UNCERTAIN", "SETTLED"] } }, select: { status: true, amountMicros: true, actualCostMicros: true } });
      const committed = rows.reduce<bigint>((sum, row) => sum + (row.status === "SETTLED" ? row.actualCostMicros ?? row.amountMicros : row.amountMicros), BigInt(0));
      if (committed + amount > policy.monthlyResearchAllowanceMicros) throw new ConnectorError("Monetary research allowance is exhausted for this period", 429);
      const value = { projectId: principal.projectId, siteId: site.id, idempotencyKey: input.idempotencyKey,
        period: input.period, timeZone: policy.researchBudgetTimeZone, policyRevision: policy.researchBudgetRevision, amountMicros: amount, currency: input.currency,
        operation: input.operation, status: "RESERVED" as const, detail: input.detail === undefined ? undefined : json(input.detail) };
      return tx.researchBudgetReservation.create({ data: value });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if ((error as { code?: string }).code === "P2002" || (error as { code?: string }).code === "P2034") throw new ConnectorError("Budget reservation raced another request; reconcile before retrying", 409);
    throw error;
  }
}

export async function settleConnectorBudget(principal: ServicePrincipalContext, reservationId: string, input: {
  status: "reserved" | "settled" | "released" | "uncertain"; actualCostMicros?: string; providerTaskId?: string | null; detail?: unknown;
}) {
  const prior = await db.researchBudgetReservation.findFirst({ where: { id: reservationId, projectId: principal.projectId } });
  if (!prior) throw new ConnectorError("Budget reservation not found", 404);
  const status = input.status.toUpperCase() as "RESERVED" | "SETTLED" | "RELEASED" | "UNCERTAIN";
  const actual = input.actualCostMicros === undefined ? null : BigInt(input.actualCostMicros);
  if (status === "RESERVED") {
    if (!["RESERVED", "UNCERTAIN"].includes(prior.status)) throw new ConnectorError("Budget reservation is already terminal", 409);
    if (prior.status === "RESERVED" && (input.providerTaskId === undefined || prior.providerTaskId === input.providerTaskId)) return prior;
    const updated = await db.researchBudgetReservation.updateMany({ where: { id: prior.id, projectId: principal.projectId, status: prior.status }, data: {
      status: "RESERVED", providerTaskId: input.providerTaskId ?? undefined,
      detail: input.detail === undefined ? undefined : json(input.detail), settledAt: null } });
    if (updated.count !== 1) throw new ConnectorError("Budget reservation changed concurrently; reconcile its receipt", 409);
    return db.researchBudgetReservation.findUnique({ where: { id: prior.id } });
  }
  if (prior.status === status) {
    if ((prior.actualCostMicros?.toString() ?? null) !== (actual?.toString() ?? null)
      || (input.providerTaskId !== undefined && prior.providerTaskId !== input.providerTaskId)) throw new ConnectorError("Budget settlement cannot be reused with different data", 409);
    return prior;
  }
  if (!["RESERVED", "UNCERTAIN"].includes(prior.status)) throw new ConnectorError("Budget reservation is already terminal", 409);
  if (status === "SETTLED" && actual === null) throw new ConnectorError("Settled research must include actual cost", 400);
  const updated = await db.researchBudgetReservation.updateMany({ where: { id: prior.id, projectId: principal.projectId, status: prior.status }, data: {
    status, actualCostMicros: actual, providerTaskId: input.providerTaskId ?? undefined,
    detail: input.detail === undefined ? undefined : json(input.detail), settledAt: status === "UNCERTAIN" ? null : new Date() } });
  if (updated.count !== 1) throw new ConnectorError("Budget reservation changed concurrently; reconcile its receipt", 409);
  return db.researchBudgetReservation.findUnique({ where: { id: prior.id } });
}

export async function getConnectorBudgetReservation(principal: ServicePrincipalContext, reservationId: string) {
  const reservation = await db.researchBudgetReservation.findFirst({ where: { id: reservationId, projectId: principal.projectId } });
  if (!reservation) throw new ConnectorError("Budget reservation not found", 404);
  return reservation;
}
