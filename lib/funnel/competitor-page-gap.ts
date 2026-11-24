import type { PrismaClient } from "@prisma/client";

import { comparePageProfiles, profileFromSnapshot, type PageGapResult, type PageProfile } from "@/lib/funnel/page-gap";
import { fetchPublicDocument, parseHtml } from "@/lib/crawler/engine";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";

/**
 * CMP-006: fetch the pages that are beating ours, and read their profile.
 *
 * Three constraints shape this, all from the issue:
 *
 *  1. **Only for queries that already have a live opportunity**, top three results.
 *     Fetching every competitor of every query would be a crawler pointed at other
 *     people's sites.
 *  2. **Cached.** A URL read today is not read again for 30 days. The cache is the
 *     evidence store itself — a `onpage_crawl` row with `scope: "competitor"` —
 *     so a second opportunity on the same query reuses the profile and there is no
 *     second store to keep in sync.
 *  3. **Cap and report.** A run has a ceiling; everything beyond it is counted and
 *     returned so the caller can say how many were skipped.
 *
 * All fetching goes through `fetchPublicDocument`, which already refuses private
 * addresses, enforces a byte ceiling, a deadline and a redirect limit. Nothing here
 * copies competitor content into our pages: the profile is evidence.
 */

/** A competitor page is not re-read inside this window. */
export const COMPETITOR_CACHE_DAYS = 30;

/** How many competitors above us to read per query. */
export const COMPETITORS_PER_QUERY = 3;

export type CompetitorFetchDb = Pick<PrismaClient, "evidenceRecord" | "rawProviderResponse">;

export type FetchedProfile = PageProfile & {
  /** Where the profile came from: a fresh fetch or a stored one. */
  source: "fetched" | "cached";
  storedEvidenceId?: string;
};

export type CompetitorGapResult = {
  query: string;
  competitors: FetchedProfile[];
  fetch: { fetched: number; cached: number; unreadable: number; skipped: number };
  gap: PageGapResult;
};

type Reference = { url: string; domain: string; position: number | null };

/**
 * The URLs ranking above us for a query, from CMP-003's competitor rows.
 *
 * A row with no URL (the provider truncated the breadcrumb) cannot be fetched, so it
 * is not a fetch target. It is not invented either: the leaderboard still shows the
 * domain.
 */
export async function competitorReferences(
  db: CompetitorFetchDb,
  input: { projectId: string; query: string; limit?: number }
): Promise<Reference[]> {
  const rows = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "competitor_rank", supersededById: null },
    select: { dimensions: true, metrics: true },
  });
  const references: Reference[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as { query?: string; domain?: string; url?: string; rankAbsolute?: number };
    if (dims.query !== input.query) continue;
    if (typeof dims.url !== "string" || !dims.url.startsWith("http")) continue;
    if (seen.has(dims.url)) continue;
    seen.add(dims.url);
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    references.push({
      url: dims.url,
      domain: typeof dims.domain === "string" ? dims.domain : "",
      position: metrics["provider:position"]?.value ?? dims.rankAbsolute ?? null,
    });
  }
  return references
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
    .slice(0, input.limit ?? COMPETITORS_PER_QUERY);
}

/** A stored competitor profile for this URL, when it is still fresh. */
async function cachedProfile(
  db: CompetitorFetchDb,
  input: { projectId: string; url: string; now: Date }
): Promise<{ profile: PageProfile; evidenceId: string } | null> {
  const cutoff = new Date(input.now.getTime() - COMPETITOR_CACHE_DAYS * 86_400_000);
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: input.projectId,
      kind: "onpage_crawl",
      supersededById: null,
      observedAt: { gte: cutoff },
    },
    select: { id: true, observedAt: true, dimensions: true, metrics: true },
    orderBy: { observedAt: "desc" },
  });
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as {
      scope?: string;
      url?: string;
      unreadable?: string | null;
      title?: string;
      wordCount?: number;
      h1Count?: number;
      headings?: string[];
      schemaTypes?: string[];
      internalLinks?: number;
      lastModified?: string;
    };
    if (dims.scope !== "competitor" || dims.url !== input.url) continue;
    // An unreadable page is cached too: retrying a 404 every run is how a run
    // becomes a nuisance to another site. `null` means it was readable, so the
    // stored value is turned back into a reason only when there is one.
    const unreadableReason =
      typeof dims.unreadable === "string" && dims.unreadable.length > 0 ? dims.unreadable : undefined;
    return {
      evidenceId: row.id,
      profile: {
        url: input.url,
        domain: null,
        position: null,
        title: dims.title ?? null,
        wordCount: typeof dims.wordCount === "number" ? dims.wordCount : null,
        h1Count: typeof dims.h1Count === "number" ? dims.h1Count : null,
        headings: Array.isArray(dims.headings) ? dims.headings : [],
        hasSchema: Array.isArray(dims.schemaTypes) ? dims.schemaTypes.length > 0 : null,
        schemaTypes: Array.isArray(dims.schemaTypes) ? dims.schemaTypes : [],
        internalLinks: typeof dims.internalLinks === "number" ? dims.internalLinks : null,
        lastModified: dims.lastModified ? new Date(dims.lastModified) : null,
        fetchedAt: row.observedAt,
        unreadable: unreadableReason,
      },
    };
  }
  return null;
}

/**
 * Read one competitor page and return its profile.
 *
 * Failures are recorded as `unreadable` with the reason rather than thrown: one
 * page behind a WAF must not stop the other two from being compared.
 */
export async function readCompetitorPage(input: {
  url: string;
  domain: string | null;
  position: number | null;
  now?: Date;
  fetch?: typeof fetchPublicDocument;
}): Promise<PageProfile> {
  const now = input.now ?? new Date();
  const base: PageProfile = {
    url: input.url,
    domain: input.domain,
    position: input.position,
    title: null,
    wordCount: null,
    h1Count: null,
    headings: [],
    hasSchema: null,
    schemaTypes: [],
    internalLinks: null,
    lastModified: null,
    fetchedAt: now,
  };

  const fetchPage = input.fetch ?? fetchPublicDocument;
  let document;
  try {
    document = await fetchPage(input.url, { maxBytes: 2_000_000, timeoutMs: 20_000 });
  } catch (error) {
    return {
      ...base,
      unreadable: `fetch failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`,
    };
  }

  if (document.statusCode < 200 || document.statusCode >= 300) {
    return { ...base, unreadable: `HTTP ${document.statusCode}` };
  }
  const contentType = (document.contentType ?? "").toLowerCase();
  if (contentType && !contentType.includes("html")) {
    return { ...base, unreadable: `not an HTML page (${contentType.split(";")[0]})` };
  }

  // The same parser the site crawl uses, so a word count means the same thing on
  // both sides of the comparison.
  const snapshot = parseHtml(document.finalUrl || input.url, document.html, document.statusCode, 0, document.bytes, null, input.url);
  const profile = profileFromSnapshot(snapshot, {
    url: input.url,
    domain: input.domain,
    position: input.position,
    fetchedAt: now,
  });
  return profile;
}

/**
 * Read the pages above us for one query and compute the gap.
 *
 * `apply: false` reads nothing and returns the cached profiles only, so a caller can
 * report what the cache already knows.
 */
export async function competitorPageGap(
  db: CompetitorFetchDb,
  input: {
    projectId: string;
    siteId: string | null;
    query: string;
    ours: PageProfile | null;
    /** Overflow for the whole run, not per query. */
    remaining?: number;
    now?: Date;
    apply: boolean;
    fetch?: typeof fetchPublicDocument;
    store?: (profile: PageProfile) => Promise<string>;
  }
): Promise<CompetitorGapResult> {
  const now = input.now ?? new Date();
  const references = await competitorReferences(db, { projectId: input.projectId, query: input.query });
  const competitors: FetchedProfile[] = [];
  const fetchCounts = { fetched: 0, cached: 0, unreadable: 0, skipped: 0 };
  let remaining = input.remaining ?? Number.POSITIVE_INFINITY;

  for (const reference of references) {
    const cached = await cachedProfile(db, { projectId: input.projectId, url: reference.url, now });
    if (cached) {
      // The stored profile keeps the domain and position from this query's own
      // ranking evidence: the cache holds the page, not who is beating whom.
      competitors.push({
        ...cached.profile,
        domain: reference.domain,
        position: reference.position,
        source: "cached",
        storedEvidenceId: cached.evidenceId,
      });
      fetchCounts.cached += 1;
      if (cached.profile.unreadable) fetchCounts.unreadable += 1;
      continue;
    }

    if (!input.apply) {
      fetchCounts.skipped += 1;
      continue;
    }
    if (remaining <= 0) {
      fetchCounts.skipped += 1;
      continue;
    }

    remaining -= 1;
    const profile = await readCompetitorPage({
      url: reference.url,
      domain: reference.domain,
      position: reference.position,
      now,
      fetch: input.fetch,
    });
    const storedEvidenceId = input.store ? await input.store(profile) : undefined;
    competitors.push({ ...profile, source: "fetched", storedEvidenceId });
    fetchCounts.fetched += 1;
    if (profile.unreadable) fetchCounts.unreadable += 1;
  }

  return {
    query: input.query,
    competitors,
    fetch: fetchCounts,
    gap: comparePageProfiles({ ours: input.ours, competitors }),
  };
}

/** Read our own crawled page for a query, or null when it was never crawled. */
export async function ourPageProfile(
  db: CompetitorFetchDb & { auditPage?: Pick<PrismaClient, "auditPage">["auditPage"] },
  input: { projectId: string; query: string }
): Promise<{ url: string; profile: PageProfile } | null> {
  const ranks = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "keyword_rank", supersededById: null },
    select: { dimensions: true, metrics: true },
  });
  let best: { url: string; position: number } | null = null;
  for (const row of ranks) {
    const dims = (row.dimensions ?? {}) as { query?: string; url?: string };
    if (dims.query !== input.query) continue;
    if (typeof dims.url !== "string" || !dims.url.startsWith("http")) continue;
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position = metrics["provider:position"]?.value ?? metrics["first_party:position"]?.value ?? null;
    if (position == null || position <= 0) continue;
    if (!best || position < best.position) best = { url: dims.url, position };
  }
  if (!best) return null;

  const empty: PageProfile = {
    url: best.url,
    domain: null,
    position: best.position,
    title: null,
    wordCount: null,
    h1Count: null,
    headings: [],
    hasSchema: null,
    schemaTypes: [],
    internalLinks: null,
    lastModified: null,
    fetchedAt: null,
  };
  if (!db.auditPage) return { url: best.url, profile: empty };

  const page = await db.auditPage.findFirst({
    where: { url: best.url, crawl: { site: { projectId: input.projectId } } },
    select: { title: true, h1s: true, h1Count: true, wordCount: true, internalLinks: true, hasSchema: true },
    orderBy: { crawl: { startedAt: "desc" } },
  });
  if (!page) return { url: best.url, profile: empty };

  const headings = Array.isArray(page.h1s)
    ? (page.h1s as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  return {
    url: best.url,
    profile: {
      ...empty,
      title: page.title ?? null,
      wordCount: page.wordCount,
      h1Count: page.h1Count,
      headings,
      hasSchema: page.hasSchema,
      internalLinks: page.internalLinks,
    },
  };
}

/**
 * CMP-006: the gap for a query, read from stored profiles only.
 *
 * A page view must never fetch somebody else's site: opening an opportunity is a
 * read, and a board full of opportunities would otherwise become a crawler. The
 * fetch happens in the scheduled pass; this only assembles what is already stored.
 */
export async function storedPageGap(
  db: CompetitorFetchDb & { auditPage?: Pick<PrismaClient, "auditPage">["auditPage"] },
  input: { projectId: string; query: string }
): Promise<PageGapResult> {
  const ours = await ourPageProfile(db, { projectId: input.projectId, query: input.query });
  const result = await competitorPageGap(db, {
    projectId: input.projectId,
    siteId: null,
    query: input.query,
    ours: ours?.profile ?? null,
    apply: false,
  });
  return result.gap;
}

/**
 * CMP-006: store one competitor page profile.
 *
 * The profile lives in dimensions rather than metrics: these are page facts read at
 * fetch time, not collected measurements with a unit the registry would have to
 * declare for every field of a page. `scope: "competitor"` is what separates it
 * from our own crawl rows in the same kind.
 */
export async function storeCompetitorProfile(
  db: CompetitorFetchDb & { evidenceRecord: Pick<PrismaClient, "evidenceRecord">["evidenceRecord"] },
  input: { projectId: string; siteId: string | null; query: string; profile: PageProfile }
): Promise<string> {
  const profile = input.profile;
  const dimensions: Record<string, unknown> = {
    scope: "competitor",
    url: profile.url,
    query: input.query,
    unreadable: profile.unreadable ?? null,
    title: profile.title,
    wordCount: profile.wordCount,
    h1Count: profile.h1Count,
    headings: profile.headings,
    schemaTypes: profile.schemaTypes,
    internalLinks: profile.internalLinks,
    lastModified: profile.lastModified ? profile.lastModified.toISOString() : null,
  };
  const stored = await storeEvidenceRecord(db as never, {
    projectId: input.projectId,
    siteId: input.siteId,
    kind: "onpage_crawl",
    observedAt: new Date(),
    producer: "lib/funnel/competitor-page-gap",
    dimensions: dimensions as never,
    metrics: {},
  });
  return stored.id;
}

export type { PageGapResult };

