import { IntegrationProvider } from "@prisma/client";
import { db } from "@/lib/db";
import { getSupersededSiteIds } from "@/lib/research/execution-authority";
import {
  fetchPageAnalytics,
  fetchSearchAnalytics,
  type KeywordData,
} from "@/lib/google";
import { getDateRange } from "@/lib/date-utils";
import {
  getProjectGoogleProvider,
  markGrantFailure,
  markGrantSuccess,
} from "@/lib/integrations/google/connections";
import type { GoogleCredentialProvider } from "@/lib/integrations/google/credential-provider";

export interface SyncResult {
  success: boolean;
  keywordsInserted: number;
  pagesInserted: number;
  startDate: string;
  endDate: string;
  error?: string;
}

export type SyncDateRange = {
  startDate: string;
  endDate: string;
};

function normalizedDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "GSC sync failed";
  return error.message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password|private[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

async function upsertRows(
  siteId: string,
  keywords: KeywordData[],
  pages: KeywordData[]
): Promise<{ keywordsInserted: number; pagesInserted: number }> {
  let keywordsInserted = 0;
  let pagesInserted = 0;

  for (let offset = 0; offset < keywords.length; offset += 100) {
    const batch = keywords.slice(offset, offset + 100);
    await db.$transaction(
      batch.map((keyword) => {
        const page = keyword.page ?? "";
        const device = keyword.device ?? "";
        const country = keyword.country ?? "";
        const date = normalizedDate(keyword.date);
        return db.keyword.upsert({
          where: {
            siteId_query_date_page_device_country: {
              siteId,
              query: keyword.query,
              date,
              page,
              device,
              country,
            },
          },
          create: {
            siteId,
            query: keyword.query,
            date,
            clicks: keyword.clicks,
            impressions: keyword.impressions,
            ctr: keyword.ctr,
            position: keyword.position,
            page,
            device,
            country,
          },
          update: {
            clicks: keyword.clicks,
            impressions: keyword.impressions,
            ctr: keyword.ctr,
            position: keyword.position,
          },
        });
      })
    );
    keywordsInserted += batch.length;
  }

  for (let offset = 0; offset < pages.length; offset += 100) {
    const batch = pages.slice(offset, offset + 100).filter((page) => page.page);
    await db.$transaction(
      batch.map((page) => {
        const date = normalizedDate(page.date);
        return db.page.upsert({
          where: {
            siteId_url_date: {
              siteId,
              url: page.page!,
              date,
            },
          },
          create: {
            siteId,
            url: page.page!,
            date,
            clicks: page.clicks,
            impressions: page.impressions,
            ctr: page.ctr,
            position: page.position,
          },
          update: {
            clicks: page.clicks,
            impressions: page.impressions,
            ctr: page.ctr,
            position: page.position,
          },
        });
      })
    );
    pagesInserted += batch.length;
  }

  return { keywordsInserted, pagesInserted };
}

async function syncWithProvider(
  auth: string | GoogleCredentialProvider,
  siteId: string,
  property: string,
  daysBack: number,
  dateRange?: SyncDateRange
): Promise<SyncResult> {
  const fallback = getDateRange(daysBack);
  const start = dateRange?.startDate ?? fallback.start;
  const end = dateRange?.endDate ?? fallback.end;
  const [keywords, pages] = await Promise.all([
    fetchSearchAnalytics(
      auth,
      property,
      start,
      end,
      ["query", "page", "date", "device", "country"]
    ),
    fetchPageAnalytics(auth, property, start, end),
  ]);
  const counts = await upsertRows(siteId, keywords, pages);
  return {
    success: true,
    ...counts,
    startDate: start,
    endDate: end,
  };
}

async function recordCoverage(syncRunId: string | undefined, result: SyncResult): Promise<void> {
  if (!syncRunId || !result.success) return;
  const current = await db.syncRun.findUnique({
    where: { id: syncRunId },
    select: { metadata: true },
  });
  const metadata = current?.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
    ? current.metadata as Record<string, unknown>
    : {};
  await db.syncRun.update({
    where: { id: syncRunId },
    data: {
      metadata: {
        ...metadata,
        coverage: { startDate: result.startDate, endDate: result.endDate },
        rows: { keywords: result.keywordsInserted, pages: result.pagesInserted },
      },
    },
  });
}

/** Syncs a legacy user-owned site through its existing OAuth token. */
export async function syncGSCDataForSite(
  userId: string,
  siteId: string,
  daysBack = 28,
  syncRunId?: string,
  dateRange?: SyncDateRange
): Promise<SyncResult> {
  try {
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, gscProperty: true },
    });
    if (!site || site.userId !== userId) throw new Error("Site not found");
    if (!site.gscProperty) throw new Error("Site does not have GSC property connected");

    // The string form keeps the legacy OAuth path intact during migration.
    const result = await syncWithProvider(userId, siteId, site.gscProperty, daysBack, dateRange);
    await recordCoverage(syncRunId, result);
    return result;
  } catch (error) {
    return {
      success: false,
      keywordsInserted: 0,
      pagesInserted: 0,
      startDate: "",
      endDate: "",
      error: safeError(error),
    };
  }
}

/**
 * Syncs a project-owned site using the encrypted CrawlSEO Google connection.
 */
export async function syncGSCDataForProject(
  projectId: string,
  siteId: string,
  daysBack = 28,
  syncRunId?: string,
  dateRange?: SyncDateRange
): Promise<SyncResult> {
  let grantId: string | undefined;
  try {
    const site = await db.site.findFirst({
      where: { id: siteId, projectId },
      select: { id: true },
    });
    if (!site) throw new Error("Site not found");

    const integration = await getProjectGoogleProvider(
      projectId,
      IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
      { siteId }
    );
    grantId = integration.grant.id;
    const result = await syncWithProvider(
      integration.provider,
      siteId,
      integration.grant.externalResourceId,
      daysBack,
      dateRange
    );
    await markGrantSuccess(grantId);
    await recordCoverage(syncRunId, result);
    return result;
  } catch (error) {
    if (grantId) await markGrantFailure(grantId, "GSC_SYNC_FAILED").catch(() => undefined);
    return {
      success: false,
      keywordsInserted: 0,
      pagesInserted: 0,
      startDate: "",
      endDate: "",
      error: safeError(error),
    };
  }
}

/** Syncs all legacy user-owned sites sequentially. */
export async function syncAllUserSites(userId: string): Promise<
  Array<{ siteId: string; domain: string; result: SyncResult }>
> {
  const [queriedSites, superseded] = await Promise.all([
    db.site.findMany({
      where: { userId },
      select: { id: true, domain: true },
    }),
    getSupersededSiteIds(),
  ]);
  const sites = queriedSites.filter((site) => !superseded.has(site.id));
  const results: Array<{ siteId: string; domain: string; result: SyncResult }> = [];
  for (const site of sites) {
    results.push({
      siteId: site.id,
      domain: site.domain,
      result: await syncGSCDataForSite(userId, site.id),
    });
  }
  return results;
}
