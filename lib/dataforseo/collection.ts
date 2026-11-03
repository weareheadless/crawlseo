import type { PrismaClient } from "@prisma/client";

import { executeDataForSeoKeywordOverview, executeDataForSeoOrganicSerp, performDataForSeoOperation } from "@/lib/dataforseo/client";
import { ingestAiVisibility, type AiVisibilityObservation } from "@/lib/dataforseo/ai-visibility-adapter";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import { decryptCredential } from "@/lib/encryption";
import { projectConnectorBudget, reserveProjectConnectorBudget, settleConnectorBudget, ConnectorError } from "@/lib/connectors/service";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import { createHash } from "node:crypto";

/**
 * Paid collection primitives (plan §2.2, Wave 0.5).
 *
 * One implementation used by both the collection scripts and the join runner, so
 * a follow-up join and a manual run record the same evidence with the same
 * provenance. Every provider call stores a RawProviderResponse first; provider
 * metrics are refused without one.
 */

export type CollectionInput = {
  projectId: string;
  siteId: string | null;
  queries: string[];
  languageCode: string;
  locationCode: number;
  domain?: string;
  /** SERP device; rankings differ between desktop and mobile. */
  device?: "desktop" | "mobile";
};

export type CollectedEvidence = {
  id: string;
  kind: string;
  observedAt: Date;
  dimensions: unknown;
  metrics: unknown;
};

export type CollectionOutput = { evidence: CollectedEvidence[]; spentMicros: number };

export type CollectionDb = Pick<PrismaClient, "rawProviderResponse" | "evidenceRecord" | "providerCredential"> &
  Parameters<typeof storeEvidenceRecord>[0];

const microsOf = (value: number | null | undefined) => (value == null ? 0 : value);

/**
 * Every paid call reserves against the project's DS-08 allowance before it runs
 * and settles the actual cost after. Without this the monthly ledger never sees
 * the spend (Atelier showed $0.50 remaining after ~$0.16 had been spent).
 *
 * The reservation idempotency key is per (operation, target, period), so the
 * ledger counts a target once per budget period even if it is collected twice.
 * A prior settled reservation is not settled again.
 */
async function withBudget<T>(
  projectId: string,
  input: { operation: string; detail: Record<string, unknown>; run: () => Promise<T>; costOf: (result: T) => number }
): Promise<{ result: T; spentMicros: number; skippedSettle: boolean }> {
  const principal = { projectId } as ServicePrincipalContext;
  const budget = await projectConnectorBudget(principal);
  if (!budget.configured || !budget.allowanceMicros || budget.currency !== "USD") {
    throw new ConnectorError("A USD research allowance is required before paid collection", 409);
  }
  const period = budget.period;
  const key = `collect:${input.operation}:${createHash("sha256").update(JSON.stringify({ ...input.detail, period })).digest("hex").slice(0, 32)}`;
  const reservation = await reserveProjectConnectorBudget(principal, {
    period,
    policyRevision: budget.policyRevision,
    idempotencyKey: key,
    amountMicros: budget.maxOperationMicros ?? "0",
    currency: "USD",
    operation: input.operation,
    detail: input.detail,
  });
  const alreadySettled = reservation.status !== "RESERVED";
  try {
    const result = await input.run();
    const spentMicros = input.costOf(result);
    if (!alreadySettled) {
      await settleConnectorBudget(principal, reservation.id, { status: "settled", actualCostMicros: String(spentMicros) });
    }
    return { result, spentMicros, skippedSettle: alreadySettled };
  } catch (error) {
    if (!alreadySettled) {
      await settleConnectorBudget(principal, reservation.id, { status: "released", detail: { reason: "provider_failure" } });
    }
    throw error;
  }
}

export async function collectKeywordMetrics(db: CollectionDb, input: CollectionInput): Promise<CollectionOutput> {
  const { result: overview, spentMicros: spent } = await withBudget(input.projectId, {
    operation: "dataforseo:keyword_metrics",
    detail: { queries: input.queries.slice(0, 20), locale: `${input.languageCode}:${input.locationCode}` },
    run: () =>
      executeDataForSeoKeywordOverview({
        projectId: input.projectId,
        keywords: input.queries,
        languageCode: input.languageCode,
        locationCode: input.locationCode,
      }),
    costOf: (result) => microsOf(result.costMicros),
  });
  const raw = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo",
      product: "dataforseo_labs",
      endpoint: "keyword_overview/live",
      providerTaskId: overview.providerTaskId,
      locale: `${input.languageCode}:${input.locationCode}`,
      requestedAt: new Date(),
      deliveredAt: new Date(),
      costMicros: BigInt(spent),
      status: "succeeded",
      payload: overview.result as never,
    },
    select: { id: true },
  });

  const evidence: CollectedEvidence[] = [];
  for (const metric of overview.result) {
    if (!metric.keyword) continue;
    const metrics: Record<string, { value: number | null; unit: string; source: "provider" }> = {};
    if (typeof metric.volume === "number") metrics["provider:volume"] = { value: metric.volume, unit: "searches/month", source: "provider" };
    if (typeof metric.difficulty === "number") metrics["provider:difficulty"] = { value: metric.difficulty, unit: "score", source: "provider" };
    if (typeof metric.cpc === "number") metrics["provider:cpc"] = { value: metric.cpc, unit: "currency", source: "provider" };
    if (typeof metric.competition === "number") metrics["provider:competition"] = { value: metric.competition, unit: "score", source: "provider" };
    if (Object.keys(metrics).length === 0) continue;
    const stored = await storeEvidenceRecord(db, {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: "keyword_metrics",
      observedAt: new Date(),
      producer: "dataforseo",
      rawResponseId: raw.id,
      dimensions: { query: metric.keyword },
      metrics,
    });
    evidence.push({ id: stored.id, kind: "keyword_metrics", observedAt: new Date(), dimensions: { query: metric.keyword }, metrics });
  }
  return { evidence, spentMicros: spent };
}

export async function collectSerpSnapshots(db: CollectionDb, input: CollectionInput): Promise<CollectionOutput> {
  const evidence: CollectedEvidence[] = [];
  let spent = 0;
  const domain = (input.domain ?? "").replace(/^www\./, "");

  for (const query of input.queries) {
    const { result: serp, spentMicros: callSpent } = await withBudget(input.projectId, {
      operation: "dataforseo:serp_snapshot",
      detail: { query, locale: `${input.languageCode}:${input.locationCode}` },
      run: () =>
        executeDataForSeoOrganicSerp({
          projectId: input.projectId,
          keyword: query,
          languageCode: input.languageCode,
          locationCode: input.locationCode,
          device: input.device,
        }),
      costOf: (result) => microsOf(result.costMicros),
    });
    spent += callSpent;
    const raw = await db.rawProviderResponse.create({
      data: {
        provider: "dataforseo",
        product: "serp",
        endpoint: "google/organic/live/advanced",
        providerTaskId: serp.providerTaskId,
        locale: `${input.languageCode}:${input.locationCode}`,
        requestedAt: new Date(),
        deliveredAt: new Date(),
        costMicros: BigInt(microsOf(serp.costMicros)),
        status: "succeeded",
        payload: serp.result as never,
      },
      select: { id: true },
    });
    const items = serp.result.organic ?? [];
    const ourPosition = items.findIndex((item) => domain !== "" && (item.url ?? "").includes(domain)) + 1;
    const covered = ourPosition === 0 || ourPosition > 10;
    const metrics: Record<string, { value: number; unit: string; source: "provider" }> = {
      "provider:organicResults": { value: items.length, unit: "count", source: "provider" },
    };
    if (ourPosition > 0) metrics["provider:position"] = { value: ourPosition, unit: "rank", source: "provider" };
    const dimensions = {
      query,
      device: input.device ?? "desktop",
      competitorCovered: covered ? "true" : "false",
      topUrl: items[0]?.url ?? null,
    };
    const stored = await storeEvidenceRecord(db, {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: "serp_snapshot",
      observedAt: new Date(),
      producer: "dataforseo",
      rawResponseId: raw.id,
      dimensions,
      metrics,
    });
    evidence.push({ id: stored.id, kind: "serp_snapshot", observedAt: new Date(), dimensions, metrics });
  }
  return { evidence, spentMicros: spent };
}

export async function collectBacklinkProfile(
  db: CollectionDb,
  input: { projectId: string; siteId: string | null; domain: string }
): Promise<CollectionOutput> {
  const { result: backlinks, spentMicros: spent } = await withBudget(input.projectId, {
    operation: "dataforseo:backlink_profile",
    detail: { domain: input.domain.replace(/^www\./, "") },
    run: () =>
      performDataForSeoOperation(input.projectId, {
        kind: "BACKLINKS_OVERVIEW",
        domain: input.domain.replace(/^www\./, ""),
      }),
    costOf: (result) => microsOf(result.costMicros),
  });
  const raw = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo",
      product: "backlinks",
      endpoint: "summary/live",
      providerTaskId: backlinks.providerTaskId,
      locale: null,
      requestedAt: new Date(),
      deliveredAt: new Date(),
      costMicros: BigInt(spent),
      status: "succeeded",
      payload: backlinks.result as never,
    },
    select: { id: true },
  });
  const value = backlinks.result as Record<string, unknown>;
  const metrics: Record<string, { value: number; unit: string; source: "provider" }> = {};
  for (const [key, unit] of [["totalBacklinks", "count"], ["referringDomains", "count"], ["referringIps", "count"], ["dofollow", "count"], ["nofollow", "count"]] as const) {
    if (typeof value[key] === "number") metrics[`provider:${key}`] = { value: value[key] as number, unit, source: "provider" };
  }
  if (Object.keys(metrics).length === 0) return { evidence: [], spentMicros: spent };
  const dimensions = { scope: "own_domain", domain: input.domain.replace(/^www\./, "") };
  const stored = await storeEvidenceRecord(db, {
    projectId: input.projectId,
    siteId: input.siteId,
    kind: "backlink_profile",
    observedAt: new Date(),
    producer: "dataforseo",
    rawResponseId: raw.id,
    dimensions,
    metrics,
  });
  return { evidence: [{ id: stored.id, kind: "backlink_profile", observedAt: new Date(), dimensions, metrics }], spentMicros: spent };
}

/**
 * AI visibility for a set of questions. `web_search` is on: without it the model
 * cannot cite anyone, so the answer would measure nothing.
 */
export async function collectAiVisibility(
  db: CollectionDb,
  input: { projectId: string; siteId: string | null; queries: string[]; languageCode: string; locationCode: number; domain: string }
): Promise<CollectionOutput> {
  const credential = await db.providerCredential.findFirstOrThrow({
    where: { provider: "dataforseo", status: "ACTIVE" },
    select: { encryptedLogin: true, encryptedPassword: true },
  });
  const auth =
    "Basic " +
    Buffer.from(`${decryptCredential(credential.encryptedLogin)}:${decryptCredential(credential.encryptedPassword)}`).toString("base64");
  const host = input.domain.replace(/^www\./, "").toLowerCase();

  const calls: Array<{ question: string; answer: string; citations: string[]; model: string | null; costUsd: number; taskId: string; payload: unknown }> = [];
  for (const question of input.queries) {
    const { result: call } = await withBudget(input.projectId, {
      operation: "dataforseo:ai_visibility",
      detail: { question, locale: `${input.languageCode}:${input.locationCode}` },
      run: () => askChatGpt(auth, question),
      costOf: (result) => Math.round((result?.costUsd ?? 0) * 1_000_000),
    });
    if (!call) continue;
    calls.push(call);
  }
  if (calls.length === 0) return { evidence: [], spentMicros: 0 };
  const spent = Math.round(calls.reduce((sum, call) => sum + call.costUsd, 0) * 1_000_000);

  const askedAt = new Date();
  const observations: AiVisibilityObservation[] = calls.map((call) => {
    const ours = call.citations.filter((url) => url.toLowerCase().includes(host)).length;
    const competitors = call.citations.filter((url) => !url.toLowerCase().includes(host)).length;
    return {
      question: call.question,
      surface: "chatgpt_search",
      model: call.model,
      locale: `${input.languageCode}:${input.locationCode}`,
      askedAt,
      samples: 1,
      citationsOfUs: ours > 0 ? 1 : 0,
      citationsOfCompetitor: competitors > 0 ? 1 : 0,
      denominator: call.citations.length,
      dataset: call.taskId,
      answered: call.answer.length > 0,
      rawExportReference: `dataforseo:${call.taskId}`,
    };
  });
  await ingestAiVisibility(db as never, observations, {
    projectId: input.projectId,
    siteId: input.siteId,
    requestedAt: askedAt,
    costMicros: BigInt(spent),
    providerTaskId: calls[0]?.taskId ?? "ai-visibility",
    payload: calls.map((call) => call.payload),
  });

  const stored = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "ai_visibility_observation", observedAt: { gte: askedAt } },
    select: { id: true, kind: true, observedAt: true, dimensions: true, metrics: true },
  });
  return { evidence: stored as CollectedEvidence[], spentMicros: spent };
}

type AiCall = { question: string; answer: string; citations: string[]; model: string | null; costUsd: number; taskId: string; payload: unknown };

/** One ChatGPT answer with web search; the only shape that can cite sources. */
async function askChatGpt(auth: string, question: string): Promise<AiCall | null> {
  const res = await fetch("https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_responses/live", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify([{ user_prompt: `${question}. Cite les sources.`, model_name: "gpt-4o-mini", max_output_tokens: 400, web_search: true }]),
  });
  const json = (await res.json()) as {
    status_code?: number;
    tasks?: Array<{ id?: string; status_code?: number; cost?: number; result?: Array<Record<string, unknown>> }>;
  };
  const task = json.tasks?.[0];
  const result = task?.result?.[0];
  if (json.status_code !== 20000 || task?.status_code !== 20000 || !result) return null;
  const items = (result.items ?? []) as Array<{ sections?: Array<{ type?: string; text?: string }> }>;
  const answer = items
    .flatMap((item) => item.sections ?? [])
    .filter((section) => section.type === "text" && typeof section.text === "string")
    .map((section) => section.text as string)
    .join("\n")
    .trim();
  const citations = ((result.search_results ?? []) as Array<{ url?: string }>)
    .map((row) => row.url)
    .filter((url): url is string => Boolean(url));
  return {
    question,
    answer,
    citations,
    model: typeof result.model_name === "string" ? result.model_name : null,
    costUsd: Number(task.cost ?? 0),
    taskId: task.id ?? "",
    payload: result,
  };
}
