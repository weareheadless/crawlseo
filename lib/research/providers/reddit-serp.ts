import { createHash } from "node:crypto";

import { executeDataForSeoOrganicSerp } from "@/lib/dataforseo/client";
import { withResearchBudget } from "@/lib/dataforseo/collection";
import type { ResearchProviderSource } from "@/lib/research/providers/types";

/**
 * Research provider: community evidence from Reddit, through the search index.
 *
 * This replaces the RSS provider, which read Reddit directly. Reddit's robots.txt
 * disallows every crawler (`User-agent: * / Disallow: /`), the RSS endpoint answers
 * this host with 403 or 429 after a single request, and its Data API requires
 * approval and a commercial licence this project does not hold. Reading the site
 * is no longer an option, so the provider reads what the search index already
 * published about it.
 *
 * What that changes, and the code has to say it plainly: a source here is a search
 * result — a URL, a title and the engine's snippet — not the thread. It is enough
 * to cite ("a thread on r/vinted_france describes this failure") and it is not
 * enough to quote. `metadata.source_kind` carries that distinction so the
 * synthesis prompt and the evidence record can both refuse to treat it as a
 * transcript.
 */

export type { ResearchProviderSource } from "@/lib/research/providers/types";

import type { PrismaClient } from "@prisma/client";

export type RedditSerpProviderInput = {
  projectId: string;
  queries: string[];
  languageCode: string;
  locationCode: number;
  /** Searches are paid, so the plan is capped: three covers the topics in practice. */
  maxQueries?: number;
  limit?: number;
  db?: Pick<PrismaClient, "rawProviderResponse">;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Only a real reddit.com URL is citable. Google returns most Reddit threads as
 * `google.com/goto?url=CAES…` — an opaque redirect token, not a link to the thread —
 * and citing that would be citing a search engine, not a discussion.
 */
function isReddit(url: string): boolean {
  const host = hostname(url);
  return host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it";
}

function subreddit(url: string): string | undefined {
  return url.match(/\/r\/([^/?#]+)/i)?.[1];
}

export async function fetchRedditSerpSources(input: RedditSerpProviderInput): Promise<ResearchProviderSource[]> {
  const retrievedAt = new Date().toISOString();
  const queries = [...new Set(input.queries.map((query) => query.trim()).filter(Boolean))].slice(0, input.maxQueries ?? 3);
  const sources: ResearchProviderSource[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];

  for (const query of queries) {
    try {
      const call = await withResearchBudget(input.projectId, {
        operation: "dataforseo:research_serp",
        detail: { query: `${query} reddit`, locale: `${input.languageCode}:${input.locationCode}`, provider: "reddit" },
        run: () =>
          executeDataForSeoOrganicSerp({
            projectId: input.projectId,
            // `site:` is accepted by the endpoint and then ignored: it returns the
            // ordinary organic set. Asking for "<query> reddit" surfaces the threads
            // and the URL filter below keeps only the ones we can cite.
            keyword: `${query} reddit`,
            languageCode: input.languageCode,
            locationCode: input.locationCode,
          }),
        costOf: (result) => result.costMicros ?? 0,
      });
      const serp = call.result;
      if (input.db) {
        await input.db.rawProviderResponse.create({
          data: {
            provider: "dataforseo",
            product: "serp",
            endpoint: "google/organic/live/advanced",
            providerTaskId: serp.providerTaskId,
            locale: `${input.languageCode}:${input.locationCode}`,
            requestedAt: new Date(),
            deliveredAt: new Date(),
            costMicros: BigInt(call.spentMicros),
            status: "succeeded",
            payload: { query: `${query} reddit`, organic: serp.result.organic } as never,
          },
        }).catch(() => undefined);
      }

      for (const item of serp.result.organic.slice(0, input.limit ?? 10)) {
        if (!item.url || !isReddit(item.url) || seen.has(item.url)) continue;
        seen.add(item.url);
        sources.push({
          provider: "reddit_serp",
          url: item.url,
          title: item.title || hostname(item.url),
          excerpt: item.description || undefined,
          community: subreddit(item.url) ? `r/${subreddit(item.url)}` : undefined,
          // A SERP carries no publication date for the thread. The date below is
          // when the result was observed, and `date_source` says so: treating it
          // as a publication date would let a 2019 thread pass a 90-day window.
          publishedAt: retrievedAt,
          contentHash: hash({ provider: "reddit_serp", query, url: item.url }),
          language: input.languageCode,
          metadata: {
            query,
            rank: item.rank,
            domain: item.domain || hostname(item.url),
            observed_at: retrievedAt,
            date_source: "observed",
            source_kind: "search_snippet",
          },
        });
      }
    } catch (error) {
      failures.push(`${query}: ${error instanceof Error ? error.message : "SERP lookup failed"}`);
    }
  }

  if (sources.length === 0 && failures.length > 0) throw new Error(failures[0]);
  return sources;
}
