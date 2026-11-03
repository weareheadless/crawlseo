import { createHash } from "node:crypto";

import { executeDataForSeoLabsSerpCompetitors, executeDataForSeoOrganicSerp } from "@/lib/dataforseo/client";
import { withResearchBudget } from "@/lib/dataforseo/collection";

/**
 * Research provider: competitor and positioning evidence from DataForSEO.
 *
 * The research runner sourced only Reddit and Google News, so a run could see what
 * people say but never who is actually present in the results. O14 ("competitors
 * position an offer we do not articulate") needs the other half: the SERP and the
 * domains that cover it.
 *
 * Two provider calls per topic:
 *  - SERP organic (location- and device-specific) → who ranks, and with what title;
 *  - Labs `serp_competitors` → which domains cover the query set, and how well.
 *
 * Both are paid, so each reserves against the project allowance first.
 */

export type ResearchProviderSource = {
  provider: string;
  url: string;
  title: string;
  author?: string;
  community?: string;
  publishedAt?: string;
  excerpt?: string;
  contentHash: string;
  language?: string;
  metadata?: Record<string, unknown>;
};

export type CompetitorProviderInput = {
  projectId: string;
  query: string;
  domain: string;
  languageCode: string;
  locationCode: number;
  device?: "desktop" | "mobile";
  limit?: number;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

export async function fetchDataForSeoCompetitorSources(input: CompetitorProviderInput): Promise<ResearchProviderSource[]> {
  const own = input.domain.replace(/^www\./, "").toLowerCase();
  const retrievedAt = new Date().toISOString();
  const sources: ResearchProviderSource[] = [];

  // 1. Who ranks for the query right now.
  const serp = await withResearchBudget(input.projectId, {
    operation: "dataforseo:research_serp",
    detail: { query: input.query, locale: `${input.languageCode}:${input.locationCode}`, device: input.device ?? "desktop" },
    run: () =>
      executeDataForSeoOrganicSerp({
        projectId: input.projectId,
        keyword: input.query,
        languageCode: input.languageCode,
        locationCode: input.locationCode,
        device: input.device,
      }),
    costOf: (result) => result.costMicros ?? 0,
  }).then((outcome) => outcome.result);

  for (const item of serp.result.organic.slice(0, input.limit ?? 10)) {
    if (!item.url || host(item.url) === own) continue;
    sources.push({
      provider: "dataforseo_serp",
      url: item.url,
      title: item.title || host(item.url),
      excerpt: item.description || undefined,
      // A SERP is observed now, not published: the retrieval time is its date.
      publishedAt: retrievedAt,
      contentHash: hash({ provider: "dataforseo_serp", query: input.query, url: item.url }),
      language: input.languageCode,
      metadata: {
        query: input.query,
        rank: item.rank,
        domain: item.domain || host(item.url),
        device: input.device ?? "desktop",
        observed_at: retrievedAt,
      },
    });
  }

  // 2. Which domains cover this query set, and how much of it.
  const competitors = await withResearchBudget(input.projectId, {
    operation: "dataforseo:research_competitors",
    detail: { query: input.query, locale: `${input.languageCode}:${input.locationCode}` },
    run: () =>
      executeDataForSeoLabsSerpCompetitors({
        projectId: input.projectId,
        keywords: [input.query],
        languageCode: input.languageCode,
        locationCode: input.locationCode,
        limit: input.limit ?? 10,
      }),
    costOf: (result) => result.costMicros ?? 0,
  }).then((outcome) => outcome.result);

  for (const competitor of competitors.result) {
    if (!competitor.domain || competitor.domain.replace(/^www\./, "").toLowerCase() === own) continue;
    const url = `https://${competitor.domain.replace(/^www\./, "")}/`;
    sources.push({
      provider: "dataforseo_labs",
      url,
      title: `${competitor.domain} covers "${input.query}"`,
      excerpt: [
        competitor.keywordsCount != null ? `${competitor.keywordsCount} keywords` : null,
        competitor.avgPosition != null ? `average position ${Math.round(competitor.avgPosition)}` : null,
        competitor.etv != null ? `estimated traffic ${Math.round(competitor.etv)}` : null,
      ].filter(Boolean).join(" · ") || undefined,
      publishedAt: retrievedAt,
      contentHash: hash({ provider: "dataforseo_labs", query: input.query, domain: competitor.domain }),
      language: input.languageCode,
      metadata: {
        query: input.query,
        domain: competitor.domain,
        keywords_count: competitor.keywordsCount,
        avg_position: competitor.avgPosition,
        etv: competitor.etv,
        observed_at: retrievedAt,
      },
    });
  }

  return sources;
}
