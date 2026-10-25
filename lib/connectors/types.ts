import { z } from "zod";

const boundedJson = z.unknown().refine((value) => {
  try { return Buffer.byteLength(JSON.stringify(value)) <= 100_000; } catch { return false; }
}, "JSON payload is too large or invalid");

export const contextSnapshotSchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  revision: z.string().trim().min(1).max(200),
  expectedRevision: z.string().trim().max(200).nullable(),
  canonicalOrigin: z.string().url().max(500),
  observedAt: z.string().datetime(),
  websiteInventory: boundedJson,
  businessFacts: boundedJson,
  capabilities: boundedJson,
});

export const actionOperationSchema = z.object({
  operation: z.enum(["accept_preparation", "decline_preparation", "request_correction", "cancel_preparation"]),
  expectedRevision: z.number().int().positive(),
  generation: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(240),
  rationale: z.string().trim().max(2000).optional(),
});

export const executionStatusSchema = z.object({
  actionRevision: z.number().int().positive(),
  generation: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(240),
  status: z.enum(["preparation_blocked", "preparation_ready", "owner_decision", "publication_verified", "outcome_measured"]),
  preparationRequestId: z.string().trim().min(1).max(240).optional(),
  candidateRef: z.string().trim().max(500).optional(),
  reviewUrl: z.string().url().max(2000).optional(),
  ownerDecision: z.enum(["approved", "declined"]).optional(),
  publicationReceipt: boundedJson.optional(),
  detail: boundedJson.optional(),
});

export const eventAckSchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  acknowledged: z.array(z.string().trim().min(1).max(100)).max(100),
  failed: z.array(z.object({ id: z.string().trim().min(1).max(100), message: z.string().trim().min(1).max(1000) })).max(100).default([]),
});

export const connectorActionListQuerySchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  since: z.string().datetime().optional(),
  cursor: z.string().trim().min(1).max(300).optional(),
});

export const connectorFindingListQuerySchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  runId: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  since: z.string().datetime().optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
});

export const connectorEventListQuerySchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const micros = z.string().regex(/^\d{1,18}$/, "micros must be a non-negative integer string");

export const budgetReserveSchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  policyRevision: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(240),
  amountMicros: micros,
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  operation: z.string().trim().min(1).max(160),
  detail: boundedJson.optional(),
});

export const budgetSettlementSchema = z.object({
  status: z.enum(["reserved", "settled", "released", "uncertain"]),
  actualCostMicros: micros.optional(),
  providerTaskId: z.string().trim().max(240).nullable().optional(),
  detail: boundedJson.optional(),
});

export const budgetPolicyUpdateSchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  expectedRevision: z.number().int().positive(),
  monthlyAllowanceMicros: micros.nullable(),
  maxOperationMicros: micros.nullable().optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  timeZone: z.string().trim().min(1).max(100),
});

export const bindingTransferSchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  expectedGeneration: z.number().int().positive(),
  expectedExecutor: z.enum(["helloada", "crawlseo-agent", "wix", "webflow"]),
  nextExecutor: z.enum(["helloada", "crawlseo-agent", "wix", "webflow"]),
  idempotencyKey: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(8).max(1000),
});

export const connectorResearchPolicySchema = z.object({
  siteId: z.string().trim().min(1).max(120),
  expectedRevision: z.number().int().min(0),
  topics: z.array(z.string().trim().min(1).max(120)).max(12),
  goals: z.array(z.string().trim().min(1).max(300)).max(12),
  exclusions: z.array(z.string().trim().min(1).max(200)).max(30),
  audience: z.string().trim().max(300).nullable(),
  market: z.string().trim().max(120).nullable(),
  language: z.string().trim().min(2).max(16),
  providers: z.array(z.enum(["reddit", "news", "web", "competitor"])).min(1).max(4),
  cadence: z.enum(["daily", "weekly", "monthly", "manual"]),
  enabled: z.boolean(),
  maxSources: z.number().int().min(1).max(100),
  monthlyBudget: z.number().int().min(0).max(500),
  recencyDays: z.number().int().min(1).max(3650),
  autoDraft: z.boolean(),
  autoAgent: z.boolean(),
});
