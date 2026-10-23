import { IntegrationProvider } from "@prisma/client";
import { db } from "@/lib/db";
import { getProjectGoogleProvider, markGrantFailure, markGrantSuccess } from "@/lib/integrations/google/connections";
import { fetchAnalyticsSummary } from "@/lib/integrations/google/ga4";

export type Ga4SyncResult = {
  success: boolean;
  periodStart: string;
  periodEnd: string;
  error?: string;
};

export type Ga4DateRange = {
  startDate: string;
  endDate: string;
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function datesForWeeklySummary(): {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
} {
  const today = new Date();
  const day = 24 * 60 * 60 * 1000;
  const date = (offset: number) => new Date(today.getTime() - offset * day);
  return {
    // Compare completed UTC days so a partially populated current day cannot
    // create false week-over-week movement.
    currentStart: isoDate(date(7)),
    currentEnd: isoDate(date(1)),
    previousStart: isoDate(date(14)),
    previousEnd: isoDate(date(8)),
  };
}

export function datesForCalendarPeriod(startDate: string, endDate: string): {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
} {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error("GA4 date range is invalid");
  }
  const day = 24 * 60 * 60 * 1000;
  const previousEnd = new Date(start.getTime() - day);
  const previousStart = new Date(Date.UTC(previousEnd.getUTCFullYear(), previousEnd.getUTCMonth(), 1));
  return {
    currentStart: startDate,
    currentEnd: endDate,
    previousStart: isoDate(previousStart),
    previousEnd: isoDate(previousEnd),
  };
}

async function recordCoverage(syncRunId: string | undefined, dates: ReturnType<typeof datesForWeeklySummary>): Promise<void> {
  if (!syncRunId) return;
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
        coverage: { startDate: dates.currentStart, endDate: dates.currentEnd },
      },
    },
  });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "GA4 sync failed").slice(0, 500);
}

export async function syncGA4DataForProject(
  projectId: string,
  siteId: string,
  syncRunId?: string,
  dateRange?: Ga4DateRange
): Promise<Ga4SyncResult> {
  let grantId: string | undefined;
  const dates = dateRange
    ? datesForCalendarPeriod(dateRange.startDate, dateRange.endDate)
    : datesForWeeklySummary();
  try {
    const site = await db.site.findFirst({
      where: { id: siteId, projectId },
      select: { id: true },
    });
    if (!site) throw new Error("Site not found");

    const integration = await getProjectGoogleProvider(
      projectId,
      IntegrationProvider.GOOGLE_ANALYTICS,
      { siteId }
    );
    grantId = integration.grant.id;
    const grantMetadata = (integration.grant.metadata ?? {}) as { hostName?: string };
    const filter = grantMetadata.hostName
      ? { hostName: grantMetadata.hostName }
      : undefined;
    const data = await fetchAnalyticsSummary(
      integration.provider,
      integration.grant.externalResourceId,
      dates,
      filter
    );
    const snapshotData = {
      ...data,
      coverage: { startDate: dates.currentStart, endDate: dates.currentEnd },
    };
    await db.analyticsSnapshot.upsert({
      where: {
        siteId_source_periodStart_periodEnd: {
          siteId,
          source: "GA4",
          periodStart: new Date(`${dates.currentStart}T00:00:00.000Z`),
          periodEnd: new Date(`${dates.currentEnd}T23:59:59.999Z`),
        },
      },
      create: {
        siteId,
        source: "GA4",
        periodStart: new Date(`${dates.currentStart}T00:00:00.000Z`),
        periodEnd: new Date(`${dates.currentEnd}T23:59:59.999Z`),
        data: snapshotData,
        ...(syncRunId ? { syncRunId } : {}),
      },
      update: {
        data: snapshotData,
        capturedAt: new Date(),
        ...(syncRunId ? { syncRunId } : {}),
      },
    });
    await recordCoverage(syncRunId, dates);
    await markGrantSuccess(grantId);
    return { success: true, periodStart: dates.currentStart, periodEnd: dates.currentEnd };
  } catch (error) {
    if (grantId) await markGrantFailure(grantId, "GA4_SYNC_FAILED").catch(() => undefined);
    return {
      success: false,
      periodStart: dates.currentStart,
      periodEnd: dates.currentEnd,
      error: safeError(error),
    };
  }
}

export async function getLatestAnalyticsSummary(
  projectId: string,
  siteId?: string
): Promise<Record<string, unknown>> {
  const snapshot = await db.analyticsSnapshot.findFirst({
    where: { site: { projectId }, ...(siteId ? { siteId } : {}) },
    orderBy: { capturedAt: "desc" },
    select: { data: true },
  });
  if (!snapshot) throw new Error("No GA4 snapshot is available");
  return snapshot.data as Record<string, unknown>;
}
