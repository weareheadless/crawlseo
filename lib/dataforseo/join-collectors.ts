import type { PrismaClient } from "@prisma/client";

import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";
import {
  collectAiVisibility,
  collectDerivedKeywordMetrics,
  collectKeywordMetrics,
  collectSerpSnapshots,
} from "@/lib/dataforseo/collection";
import type { JoinCollectors } from "@/lib/funnel/join-runner";

/**
 * The paid collectors the join runner uses, built once for every caller.
 *
 * The worker's scheduled branch built these inline, so a manual run — and every
 * other path — had no collectors and could not produce a how leg. Any tenant whose
 * joins were not run by the scheduled branch stayed at "why only". One builder,
 * used by the worker and the tenant pipeline alike.
 */
export type JoinCollectorSetup = {
  languageCode: string;
  locationCode: number;
  collectors: JoinCollectors;
};

export async function buildJoinCollectors(
  db: PrismaClient,
  input: {
    projectId: string;
    siteId: string;
    domain: string;
    language: string;
    /** The audience's market, not the business's. */
    country: string | null;
  }
): Promise<JoinCollectorSetup | null> {
  const locale = await resolveDataForSeoLocale(input.projectId, input.language, input.country)
    .catch(() => null);
  if (!locale) return null;

  return {
    languageCode: locale.languageCode,
    locationCode: locale.locationCode,
    collectors: {
      keywordMetrics: async (request) => {
        const seed = request.queries[0];
        if (!seed) return { evidence: [], spentMicros: 0 };
        const derived = await collectDerivedKeywordMetrics(db, {
          projectId: request.projectId,
          siteId: request.siteId,
          seed,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
        });
        if (derived.evidence.length > 0) return derived;
        return collectKeywordMetrics(db, {
          ...request,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
        });
      },
      /**
       * Batch keyword metrics for observed queries.
       *
       * `keywordMetrics` above derives one related phrase per seed, which is right
       * for validating a research hypothesis and wrong for enriching a list: a
       * batch of twenty observed queries came back with a single measurement.
       */
      keywordBatch: (request) =>
        collectKeywordMetrics(db, {
          ...request,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
        }),
      serpSnapshots: (request) =>
        collectSerpSnapshots(db, {
          ...request,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
          domain: input.domain,
        }),
      aiVisibility: (request) =>
        collectAiVisibility(db, {
          ...request,
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
          domain: input.domain,
        }),
    },
  };
}
