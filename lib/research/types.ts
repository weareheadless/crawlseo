import { z } from "zod";

export const researchRunKindSchema = z.enum(["MARKET", "SEO", "MIXED"]);
export const researchTriggerSchema = z.enum(["MANUAL", "SCHEDULED", "API"]);
export const researchFindingTypeSchema = z.enum([
  "THEME",
  "QUESTION",
  "CONCERN",
  "OBJECTION",
  "TREND",
  "MISCONCEPTION",
  "CONTENT_GAP",
]);
export const researchActionStatusSchema = z.enum([
  "PROPOSED",
  "APPROVED",
  "DISMISSED",
  "DRAFTING",
  "DRAFT_READY",
  "DELIVERY_APPROVED",
  "DELIVERING",
  "DELIVERED",
  "VERIFIED",
  "FAILED",
]);
export const automationModeSchema = z.enum(["MANUAL", "ASSISTED", "AUTOMATIC"]);

const shortText = (max: number) => z.string().trim().min(1).max(max);
const stringList = (maxItems: number, maxLength: number) =>
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);

export const createResearchRunSchema = z.object({
  title: shortText(160),
  kind: researchRunKindSchema.default("MARKET"),
  trigger: researchTriggerSchema.default("MANUAL"),
  topics: z.array(shortText(120)).min(1).max(12),
  audience: z.string().trim().max(300).optional(),
  market: z.string().trim().max(120).optional(),
  language: z.string().trim().min(2).max(16).default("en"),
  questions: stringList(12, 300).default([]),
  recencyDays: z.number().int().min(1).max(730).default(90),
  providers: z.array(z.enum(["reddit", "news", "web", "competitor"])).min(1).max(4).default(["reddit", "news", "web"]),
});

export const researchSourceInputSchema = z.object({
  provider: shortText(40),
  url: z.string().url().max(2000),
  title: z.string().trim().max(500).optional(),
  author: z.string().trim().max(200).optional(),
  community: z.string().trim().max(200).optional(),
  publishedAt: z.string().datetime().optional(),
  excerpt: z.string().trim().max(4000).optional(),
  contentHash: z.string().trim().max(128).optional(),
  language: z.string().trim().max(16).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ingestResearchFindingSchema = z.object({
  type: researchFindingTypeSchema,
  theme: shortText(240),
  summary: z.string().trim().min(20).max(4000),
  confidence: z.number().int().min(0).max(100).default(50),
  sentiment: z.string().trim().max(40).optional(),
  urgency: z.string().trim().max(40).optional(),
  suggestedActionKind: z.string().trim().max(80).optional(),
  sources: z.array(researchSourceInputSchema).min(1).max(20),
});

export const createResearchActionSchema = z.object({
  runId: z.string().trim().max(120).optional(),
  findingId: z.string().trim().max(120).optional(),
  source: shortText(60),
  kind: shortText(80),
  format: z.string().trim().max(40).optional(),
  title: shortText(240),
  primaryQuery: z.string().trim().max(300).optional(),
  targetUrl: z.string().url().max(2000).optional(),
  recommendation: z.string().trim().min(10).max(4000),
  priorityRationale: z.string().trim().max(1000).optional(),
  requiredCapabilities: stringList(32, 100).optional(),
  acceptanceCriteria: stringList(20, 500).optional(),
  dependencies: stringList(20, 200).optional(),
  reassessmentConditions: stringList(20, 500).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(0).max(100).default(50),
  automationMode: automationModeSchema.default("MANUAL"),
  dedupeKey: z.string().trim().min(8).max(160).optional(),
});

export const updateResearchActionSchema = z.object({
  status: researchActionStatusSchema.optional(),
  automationMode: automationModeSchema.optional(),
  owner: z.string().trim().max(200).nullable().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

export type ResearchSourceInput = z.infer<typeof researchSourceInputSchema>;
export type CreateResearchRunInput = z.infer<typeof createResearchRunSchema>;
export type IngestResearchFindingInput = z.infer<typeof ingestResearchFindingSchema>;
export type CreateResearchActionInput = z.infer<typeof createResearchActionSchema>;
export type UpdateResearchActionInput = z.infer<typeof updateResearchActionSchema>;
