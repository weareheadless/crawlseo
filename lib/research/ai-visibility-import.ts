import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { ProviderCapabilityMatrix } from "./ai-visibility-capabilities";

const envelopeSchema = z.object({
  provider: z.string().trim().min(1),
  schemaVersion: z.string().trim().min(1),
}).passthrough();

const sharedMetadataSchema = z.object({
  modelSurface: z.string().trim().min(1),
  observedAt: z.string().datetime({ offset: true }),
  questionSetVersion: z.string().trim().min(1),
  sourceKind: z.enum(["provider_export", "provider_api", "operator_manual"]),
  rawExportReference: z.string().trim().min(1),
  denominator: z.number().int().nonnegative(),
});

const normalizedObservationSchema = z.object({
  question: z.string().trim().min(1),
  // Null represents an engine the provider did not observe.
  answer: z.object({
    mentions: z.array(z.unknown()).optional(),
    recommendations: z.array(z.unknown()).optional(),
    citations: z.array(z.unknown()).optional(),
  }).nullable(),
});

const perplexityExportSchema = z.object({
  ...sharedMetadataSchema.shape,
  observations: z.array(z.object({
    query: z.string().trim().min(1),
    responseEvidence: z.object({
      mentionedBrands: z.array(z.unknown()).optional(),
      recommendedBrands: z.array(z.unknown()).optional(),
      citedUrls: z.array(z.unknown()).optional(),
    }).nullable(),
  })).min(1),
}).strict();

export type NormalizedAIVisibilityExport = {
  provider: string;
  schemaVersion: string;
  modelSurface: string;
  observedAt: string;
  questionSetVersion: string;
  sourceKind: "provider_export" | "provider_api" | "operator_manual";
  rawExportReference: string;
  denominator: number;
  observations: z.infer<typeof normalizedObservationSchema>[];
};

type Adapter = { normalize: (input: unknown) => NormalizedAIVisibilityExport };
const perplexityAdapter: Adapter = {
  normalize(input) {
    const parsed = perplexityExportSchema.parse(input);
    return {
      ...parsed,
      provider: "perplexity",
      schemaVersion: "ai-visibility-export-v1",
      observations: parsed.observations.map(({ query, responseEvidence }) => ({
        question: query,
        answer: responseEvidence === null ? null : {
          mentions: responseEvidence.mentionedBrands,
          recommendations: responseEvidence.recommendedBrands,
          citations: responseEvidence.citedUrls,
        },
      })),
    };
  },
};

/** Provider and schema versions select a single explicit, validated adapter. */
export const aiVisibilityAdapterRegistry: Record<string, Record<string, Adapter>> = {
  perplexity: { "ai-visibility-export-v1": perplexityAdapter },
};

function supportedPairs() {
  return Object.entries(aiVisibilityAdapterRegistry)
    .flatMap(([provider, versions]) => Object.keys(versions).map(version => `${provider}/${version}`))
    .sort();
}

export function normalizeAIVisibilityExport(body: unknown, capabilities: ProviderCapabilityMatrix): NormalizedAIVisibilityExport {
  const envelope = envelopeSchema.parse(body);
  const supported = supportedPairs();
  const adapter = aiVisibilityAdapterRegistry[envelope.provider.toLowerCase()]?.[envelope.schemaVersion];
  if (!adapter) {
    throw new Error(`Unsupported AI visibility provider/schemaVersion ${envelope.provider}/${envelope.schemaVersion}; supported pairs: ${supported.join(", ")}`);
  }
  const providerCapabilities = capabilities.providers.find(({ provider }) => provider.toLowerCase() === envelope.provider.toLowerCase());
  if (!providerCapabilities || providerCapabilities.apiOrExport.availability !== "available") {
    const availability = providerCapabilities?.apiOrExport.availability ?? "not_listed";
    throw new Error(`AI visibility import refused: ${envelope.provider} apiOrExport capability is ${availability}; supported pairs: ${supported.join(", ")}`);
  }
  const { provider, schemaVersion, ...providerPayload } = envelope;
  const normalized = adapter.normalize(providerPayload);
  return { ...normalized, provider: provider.toLowerCase(), schemaVersion };
}

export async function importAIVisibilityExport(
  prisma: PrismaClient,
  projectId: string,
  body: unknown,
  capabilities: ProviderCapabilityMatrix,
) {
  const parsed = normalizeAIVisibilityExport(body, capabilities);
  const results = [];
  for (const item of parsed.observations) {
    const observationHash = createHash("sha256").update(JSON.stringify({ ...item, parsed })).digest("hex");
    const key = {
      projectId, question: item.question, provider: parsed.provider,
      modelSurface: parsed.modelSurface, questionSetVersion: parsed.questionSetVersion,
      observedAt: new Date(parsed.observedAt),
    };
    const existing = await prisma.aIVisibilityObservation.findFirst({
      where: key,
      orderBy: { version: "desc" },
    });
    if (existing?.observationHash === observationHash) { results.push(existing); continue; }
    const version = (existing?.version ?? 0) + 1;
    const answer = item.answer;
    results.push(await prisma.aIVisibilityObservation.create({ data: {
      ...key,
      sourceKind: parsed.sourceKind,
      rawExportReference: parsed.rawExportReference,
      denominator: parsed.denominator,
      coverage: { status: answer === null || parsed.denominator === 0 ? "unknown" : "observed", reasonCode: answer === null ? "provider_not_observed" : parsed.denominator === 0 ? "zero_denominator" : null },
      mentions: answer?.mentions as Prisma.InputJsonValue | undefined,
      recommendations: answer?.recommendations as Prisma.InputJsonValue | undefined,
      citations: answer?.citations as Prisma.InputJsonValue | undefined,
      observationHash,
      version,
    } }));
  }
  return results;
}
