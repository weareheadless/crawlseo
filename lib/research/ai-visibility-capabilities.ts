import { z } from "zod";

/** Versioned inventory of evidence surfaces; deliberately contains no visibility metrics. */
export const AI_VISIBILITY_CAPABILITY_VERSION = "ai-capabilities-v2" as const;

const surfaceSchema = z.discriminatedUnion("availability", [
  z.object({ availability: z.literal("available"), details: z.string().min(1) }),
  z.object({ availability: z.literal("unavailable"), reasonCode: z.string().min(1) }),
  z.object({ availability: z.literal("unknown"), reasonCode: z.string().min(1) }),
]);

export const providerCapabilitySchema = z.object({
  provider: z.string().trim().min(1),
  dashboard: surfaceSchema,
  apiOrExport: surfaceSchema,
  unavailableSurfaces: z.array(z.string().trim().min(1)),
});

export const providerCapabilityMatrixSchema = z.object({
  version: z.literal(AI_VISIBILITY_CAPABILITY_VERSION),
  providers: z.array(providerCapabilitySchema),
}).superRefine((matrix, ctx) => {
  const ids = matrix.providers.map(({ provider }) => provider.toLowerCase());
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Provider identifiers must be unique" });
});

export type ProviderCapabilityMatrix = z.infer<typeof providerCapabilityMatrixSchema>;

/** Code-level inventory: unknown is kept distinct from unavailable. */
export const AI_VISIBILITY_CAPABILITY_INVENTORY: ProviderCapabilityMatrix = {
  version: AI_VISIBILITY_CAPABILITY_VERSION,
  providers: [
    ...["ChatGPT", "Claude", "Gemini"].map((provider) => ({
      provider,
      dashboard: { availability: "unknown" as const, reasonCode: "not_inventoried" },
      apiOrExport: { availability: "unavailable" as const, reasonCode: "no_integrated_export" },
      unavailableSurfaces: ["apiOrExport"],
    })),
    {
      provider: "Perplexity",
      dashboard: { availability: "unknown" as const, reasonCode: "not_inventoried" },
      apiOrExport: { availability: "available" as const, details: "ai-visibility-export-v1 importer" },
      unavailableSurfaces: [],
    },
  ],
};

// This is an evidence taxonomy, not a result set: no unsupported provider claims are prefilled.
export const AI_VISIBILITY_UNKNOWN_REASON = {
  NOT_OBSERVED: "not_observed",
  PROVIDER_SURFACE_UNAVAILABLE: "provider_surface_unavailable",
  NO_AUTHORIZED_DATA_SOURCE: "no_authorized_data_source",
} as const;

/** Access signals are explicitly incapable of establishing answer-engine visibility. */
export function visibilityFromAccessSignals(_signals: {
  robotsAllows?: boolean;
  sitemapContainsUrl?: boolean;
  botUserAgent?: string;
  httpStatus?: number;
}) {
  return {
    status: "unknown" as const,
    reasonCode: AI_VISIBILITY_UNKNOWN_REASON.NOT_OBSERVED,
  };
}
