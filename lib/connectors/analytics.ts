import { IntegrationProvider } from "@prisma/client";
import { db } from "@/lib/db";
import { ConnectorError, requireConnectorSite } from "@/lib/connectors/service";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import { z } from "zod";

const ROW_LIMIT = 500;
const MAX_RANGE_DAYS = 366;
type DateRange = { startDate: string; endDate: string };

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function dateRange(input?: Partial<DateRange>): DateRange {
  if (Boolean(input?.startDate) !== Boolean(input?.endDate)) throw new ConnectorError("startDate and endDate must be provided together");
  if (input?.startDate && input.endDate) {
    if (!validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate) throw new ConnectorError("Analytics date range is invalid");
    const days = (Date.parse(`${input.endDate}T00:00:00.000Z`) - Date.parse(`${input.startDate}T00:00:00.000Z`)) / 86_400_000 + 1;
    if (days > MAX_RANGE_DAYS) throw new ConnectorError(`Analytics date range cannot exceed ${MAX_RANGE_DAYS} days`);
    return { startDate: input.startDate, endDate: input.endDate };
  }
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 89);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

type SyncRun = { status: string; finishedAt: Date | null; createdAt: Date; errorCode: string | null; metadata: unknown };
function syncHealth(run: SyncRun | null) {
  return { status: run ? run.status.toLowerCase() : "none", observedAt: run?.finishedAt?.toISOString() ?? run?.createdAt.toISOString() ?? null,
    errorCode: run?.status === "FAILED" ? run.errorCode : null };
}

function runCoverage(run: SyncRun | null) {
  const metadata = run?.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
    ? run.metadata as Record<string, unknown> : {};
  const value = metadata.coverage;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const coverage = value as Record<string, unknown>;
  return typeof coverage.startDate === "string" && validDate(coverage.startDate)
    && typeof coverage.endDate === "string" && validDate(coverage.endDate) && coverage.startDate <= coverage.endDate
    ? { startDate: coverage.startDate, endDate: coverage.endDate } : null;
}

function snapshotCoverage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const coverage = value as Record<string, unknown>;
  return typeof coverage.startDate === "string" && validDate(coverage.startDate)
    && typeof coverage.endDate === "string" && validDate(coverage.endDate) && coverage.startDate <= coverage.endDate
    ? { startDate: coverage.startDate, endDate: coverage.endDate } : null;
}

function connectionState(grant: Grant | undefined, ambiguous = false) {
  if (ambiguous) return { status: "ambiguous", lastSuccessfulAt: null, errorCode: "MULTIPLE_GOOGLE_GRANTS" };
  if (!grant) return { status: "unconnected", lastSuccessfulAt: null, errorCode: null };
  const connectionStatus = grant.connection.status;
  const revoked = grant.status === "REVOKED" || connectionStatus === "REVOKED";
  const status = revoked ? "revoked"
    : connectionStatus === "NEEDS_REAUTH" ? "needs_reauth"
      : connectionStatus === "ERROR" || grant.status === "ERROR" ? "error"
        : grant.status === "UNVERIFIED" ? "unverified"
          : grant.status === "ACTIVE" && connectionStatus === "ACTIVE" ? "connected" : "unavailable";
  return { status, lastSuccessfulAt: grant.lastSuccessfulAt?.toISOString() ?? null,
    errorCode: status === "error" || status === "needs_reauth" ? grant.safeErrorCode : null };
}

type Grant = {
  id: string; provider: IntegrationProvider; status: string; externalResourceId: string; safeErrorCode: string | null;
  lastSuccessfulAt: Date | null; updatedAt: Date; connection: { status: string };
};

function selectGrant(grants: Grant[], provider: IntegrationProvider): { grant: Grant | undefined; ambiguous: boolean } {
  const candidates = grants.filter((grant) => grant.provider === provider);
  const current = candidates.filter((grant) => grant.status !== "REVOKED" && grant.connection.status !== "REVOKED");
  if (current.length > 1) return { grant: undefined, ambiguous: true };
  // No preference for a healthy credential over a broken one: ambiguity is not
  // permission to select another property. Revoked history is informational only.
  return { grant: current[0] ?? candidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))[0], ambiguous: false };
}

const metrics = z.object({ activeUsers: z.number().finite().optional(), totalUsers: z.number().finite().optional(),
  sessions: z.number().finite().optional(), screenPageViews: z.number().finite().optional() });
const delta = z.object({ activeUsers: z.number().finite().nullable().optional(), totalUsers: z.number().finite().nullable().optional(),
  sessions: z.number().finite().nullable().optional(), screenPageViews: z.number().finite().nullable().optional() });
const analyticsSummary = z.object({
  current_week: metrics.refine((value) => Object.keys(value).length > 0),
  previous_week: metrics.optional(), delta_pct: delta.optional(),
  top_pages: z.array(z.object({ path: z.string(), views: z.number().finite() })).optional(),
  sources: z.array(z.object({ source: z.string(), sessions: z.number().finite(), users: z.number().finite() })).optional(),
  organic_queries: z.array(z.object({ query: z.string(), sessions: z.number().finite(), users: z.number().finite(), views: z.number().finite() })).optional(),
});

function analyticsPayload(value: unknown): Record<string, unknown> | null {
  const parsed = analyticsSummary.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Read-only projection of persisted first-party Google observations. Never calls Google or starts a sync. */
export async function getConnectorAnalytics(principal: ServicePrincipalContext, siteId: string, requestedRange?: Partial<DateRange>) {
  const site = await requireConnectorSite(principal, siteId);
  const range = dateRange(requestedRange);
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T23:59:59.999Z`);
  const [grants, ga4, queryCount, queries, pageCount, pages, latestGscSync, latestGa4Sync, latestCompletedGscSync] = await Promise.all([
    db.integrationGrant.findMany({ where: { projectId: principal.projectId, siteId: site.id,
      provider: { in: [IntegrationProvider.GOOGLE_ANALYTICS, IntegrationProvider.GOOGLE_SEARCH_CONSOLE] } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: { id: true, provider: true, status: true, externalResourceId: true, safeErrorCode: true, lastSuccessfulAt: true, updatedAt: true,
        connection: { select: { status: true } } } }),
    db.analyticsSnapshot.findFirst({ where: { siteId: site.id, source: "GA4", periodStart: { lte: end }, periodEnd: { gte: start } },
      orderBy: { capturedAt: "desc" }, select: { id: true, data: true, capturedAt: true, periodStart: true, periodEnd: true } }),
    db.keyword.count({ where: { siteId: site.id, date: { gte: start, lte: end } } }),
    db.keyword.findMany({ where: { siteId: site.id, date: { gte: start, lte: end } }, orderBy: [{ date: "desc" }, { query: "asc" }], take: ROW_LIMIT,
      select: { query: true, date: true, clicks: true, impressions: true, ctr: true, position: true, page: true, device: true, country: true } }),
    db.page.count({ where: { siteId: site.id, date: { gte: start, lte: end } } }),
    db.page.findMany({ where: { siteId: site.id, date: { gte: start, lte: end } }, orderBy: [{ date: "desc" }, { url: "asc" }], take: ROW_LIMIT,
      select: { url: true, date: true, clicks: true, impressions: true, ctr: true, position: true } }),
    db.syncRun.findFirst({ where: { siteId: site.id, source: "GSC", status: { in: ["COMPLETED", "FAILED"] } },
      orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { status: true, finishedAt: true, createdAt: true, errorCode: true, metadata: true } }),
    db.syncRun.findFirst({ where: { siteId: site.id, source: "GA4", status: { in: ["COMPLETED", "FAILED"] } },
      orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { status: true, finishedAt: true, createdAt: true, errorCode: true, metadata: true } }),
    db.syncRun.findFirst({ where: { siteId: site.id, source: "GSC", status: "COMPLETED" },
      orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { status: true, finishedAt: true, createdAt: true, errorCode: true, metadata: true } }),
  ]);
  const gscSelection = selectGrant(grants, IntegrationProvider.GOOGLE_SEARCH_CONSOLE);
  const ga4Selection = selectGrant(grants, IntegrationProvider.GOOGLE_ANALYTICS);
  const gscGrant = gscSelection.grant;
  const ga4Grant = ga4Selection.grant;
  const ga4Metrics = analyticsPayload(ga4?.data);
  const snapshotData = ga4?.data && typeof ga4.data === "object" && !Array.isArray(ga4.data) ? ga4.data as Record<string, unknown> : null;
  const actualSnapshotCoverage = snapshotCoverage(snapshotData?.coverage);
  const coverage = actualSnapshotCoverage
    ?? (ga4 ? { startDate: ga4.periodStart.toISOString().slice(0, 10), endDate: ga4.periodEnd.toISOString().slice(0, 10) } : null);
  const gscHasRows = queryCount > 0 || pageCount > 0;
  const gscCoverage = runCoverage(latestCompletedGscSync);
  const gscConnection = connectionState(gscGrant, gscSelection.ambiguous);
  const ga4Connection = connectionState(ga4Grant, ga4Selection.ambiguous);
  return {
    schemaVersion: "1.0", projectId: principal.projectId, siteId: site.id, requestedPeriod: range,
    ga4: { status: ga4Metrics ? "available" : ga4 ? "invalid" : "missing", propertyId: ga4Grant?.externalResourceId ?? null,
      observedAt: ga4?.capturedAt.toISOString() ?? null, coverage, data: ga4Metrics,
      snapshotId: ga4?.id ?? null, connection: ga4Connection, latestSync: syncHealth(latestGa4Sync) },
    gsc: { status: gscHasRows ? "available" : "missing", propertyId: gscGrant?.externalResourceId ?? null,
      observedAt: gscHasRows ? latestCompletedGscSync?.finishedAt?.toISOString() ?? gscGrant?.lastSuccessfulAt?.toISOString() ?? null : null,
      coverage: gscCoverage, queries: queries.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
      pages: pages.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
      rowCount: { queries: queryCount, pages: pageCount }, truncation: { queries: Math.max(0, queryCount - queries.length), pages: Math.max(0, pageCount - pages.length) },
      connection: gscConnection, latestSync: syncHealth(latestGscSync) },
  };
}
