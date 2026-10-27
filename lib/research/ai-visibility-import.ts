import { z } from "zod";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

// Explicit, offline import contract. This first adapter supports the provider
// whose export format is the versioned JSON envelope below.
export const aiVisibilityExportSchema = z.object({
  version: z.literal("ai-visibility-export-v1"),
  provider: z.literal("perplexity"),
  modelSurface: z.string().trim().min(1),
  observedAt: z.string().datetime({ offset: true }),
  questionSetVersion: z.string().trim().min(1),
  sourceKind: z.enum(["provider_export", "provider_api", "operator_manual"]),
  rawExportReference: z.string().trim().min(1),
  denominator: z.number().int().nonnegative(),
  observations: z.array(z.object({
    question: z.string().trim().min(1),
    // null means the provider did not observe this engine. Never convert it to false.
    answer: z.object({
      mentions: z.array(z.unknown()).optional(),
      recommendations: z.array(z.unknown()).optional(),
      citations: z.array(z.unknown()).optional(),
    }).nullable(),
  })).min(1),
}).strict();

export type AIVisibilityExport = z.infer<typeof aiVisibilityExportSchema>;

export function parseAIVisibilityExport(body: unknown) {
  return aiVisibilityExportSchema.parse(body);
}

export async function importAIVisibilityExport(prisma: PrismaClient, projectId: string, body: unknown) {
  const parsed = parseAIVisibilityExport(body);
  const results = [];
  for (const item of parsed.observations) {
    const answer = item.answer;
    const observationHash = createHash("sha256").update(JSON.stringify({ ...item, parsed })).digest("hex");
    const key = { projectId_question_provider_modelSurface_questionSetVersion_observedAt: {
      projectId, question: item.question, provider: parsed.provider,
      modelSurface: parsed.modelSurface, questionSetVersion: parsed.questionSetVersion,
      observedAt: new Date(parsed.observedAt),
    } };
    const existing = await prisma.aIVisibilityObservation.findFirst({
      where: { ...key.projectId_question_provider_modelSurface_questionSetVersion_observedAt },
      orderBy: { version: "desc" },
    });
    if (existing?.observationHash === observationHash) { results.push(existing); continue; }
    const version = (existing?.version ?? 0) + 1;
    results.push(await prisma.aIVisibilityObservation.create({ data: {
      ...key.projectId_question_provider_modelSurface_questionSetVersion_observedAt,
      sourceKind: parsed.sourceKind, rawExportReference: parsed.rawExportReference,
      denominator: parsed.denominator,
      coverage: { status: answer === null || parsed.denominator === 0 ? "unknown" : "observed", reasonCode: answer === null ? "provider_not_observed" : parsed.denominator === 0 ? "zero_denominator" : null },
      mentions: answer?.mentions as Prisma.InputJsonValue | undefined,
      recommendations: answer?.recommendations as Prisma.InputJsonValue | undefined,
      citations: answer?.citations as Prisma.InputJsonValue | undefined,
      observationHash, version,
    } }));
  }
  return results;
}
