import type { GoogleCredentialProvider } from "./credential-provider";
import { GA4_SCOPE } from "./connections";

const API = "https://analyticsdata.googleapis.com/v1beta";

export type AnalyticsSummary = {
  current_week: Record<string, number>;
  previous_week: Record<string, number>;
  delta_pct: Record<string, number | null>;
  top_pages: Array<{ path: string; views: number }>;
  sources: Array<{ source: string; sessions: number; users: number }>;
  organic_queries: Array<{ query: string; sessions: number; users: number; views: number }>;
  /** Daily rows and dimension tables the connector can answer any range from. */
  history: AnalyticsHistory;
};

type ReportRow = {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
};

export type AnalyticsFilter = {
  /** Restrict a property-level report to one site's host (shared GA4 property). */
  hostName?: string;
};

function hostFilter(filter?: AnalyticsFilter): Record<string, unknown> | undefined {
  const hostName = filter?.hostName?.trim();
  if (!hostName) return undefined;
  return {
    filter: {
      fieldName: "hostName",
      stringFilter: { matchType: "EXACT", value: hostName },
    },
  };
}

function propertyPath(propertyId: string): string {
  const normalized = propertyId.trim().replace(/^properties\//, "");
  if (!/^\d+$/.test(normalized)) throw new Error("GA4 property ID is invalid");
  return normalized;
}

async function runReport(
  provider: GoogleCredentialProvider,
  propertyId: string,
  body: Record<string, unknown>
): Promise<{ metricHeaders?: Array<{ name?: string }>; rows?: ReportRow[] }> {
  const token = await provider.getAccessToken([GA4_SCOPE]);
  const response = await fetch(
    `${API}/properties/${propertyPath(propertyId)}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(`GA4 report failed with status ${response.status}`);
  }
  return (await response.json()) as { metricHeaders?: Array<{ name?: string }>; rows?: ReportRow[] };
}

function value(row: ReportRow | undefined, index: number): number {
  return Number(row?.metricValues?.[index]?.value ?? 0);
}

function metricNames(result: { metricHeaders?: Array<{ name?: string }> }): string[] {
  return (result.metricHeaders ?? []).map((header) => header.name ?? "");
}

async function totals(
  provider: GoogleCredentialProvider,
  propertyId: string,
  startDate: string,
  endDate: string,
  filter?: AnalyticsFilter
): Promise<Record<string, number>> {
  const result = await runReport(provider, propertyId, {
    dateRanges: [{ startDate, endDate }],
    dimensionFilter: hostFilter(filter),
    metrics: [
      { name: "activeUsers" },
      { name: "newUsers" },
      { name: "totalUsers" },
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "engagementRate" },
      { name: "screenPageViews" },
      { name: "eventCount" },
      { name: "averageSessionDuration" },
    ],
  });
  const row = result.rows?.[0];
  return Object.fromEntries(metricNames(result).map((name, index) => [name, value(row, index)]));
}

async function topPages(
  provider: GoogleCredentialProvider,
  propertyId: string,
  startDate: string,
  endDate: string,
  filter?: AnalyticsFilter
): Promise<AnalyticsSummary["top_pages"]> {
  const result = await runReport(provider, propertyId, {
    dateRanges: [{ startDate, endDate }],
    dimensionFilter: hostFilter(filter),
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "screenPageViews" }],
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit: 10,
  });
  return (result.rows ?? []).map((row) => ({
    path: row.dimensionValues?.[0]?.value ?? "",
    views: Math.round(value(row, 0)),
  }));
}

async function sources(
  provider: GoogleCredentialProvider,
  propertyId: string,
  startDate: string,
  endDate: string,
  filter?: AnalyticsFilter
): Promise<AnalyticsSummary["sources"]> {
  const result = await runReport(provider, propertyId, {
    dateRanges: [{ startDate, endDate }],
    dimensionFilter: hostFilter(filter),
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }, { name: "totalUsers" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 8,
  });
  return (result.rows ?? []).map((row) => ({
    source: row.dimensionValues?.[0]?.value ?? "",
    sessions: Math.round(value(row, 0)),
    users: Math.round(value(row, 1)),
  }));
}

async function organicQueries(
  provider: GoogleCredentialProvider,
  propertyId: string,
  startDate: string,
  endDate: string,
  filter?: AnalyticsFilter
): Promise<AnalyticsSummary["organic_queries"]> {
  try {
    const result = await runReport(provider, propertyId, {
      dateRanges: [{ startDate, endDate }],
      dimensionFilter: hostFilter(filter),
      dimensions: [{ name: "googleOrganicSearchQuery" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "screenPageViews" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 10,
    });
    return (result.rows ?? []).map((row) => ({
      query: row.dimensionValues?.[0]?.value ?? "",
      sessions: Math.round(value(row, 0)),
      users: Math.round(value(row, 1)),
      views: Math.round(value(row, 2)),
    }));
  } catch {
    // The Search Console product link is optional and can return a provider
    // error even when ordinary Analytics reports are healthy.
    return [];
  }
}


export type AnalyticsHistory = {
  coverage: { startDate: string; endDate: string; days: number };
  daily: Array<{ date: string; sessions: number; activeUsers: number; screenPageViews: number; eventCount: number }>;
  pages: Array<{ path: string; views: number; sessions: number }>;
  channels: Array<{ channel: string; sessions: number; users: number; engagementRate: number }>;
  devices: Array<{ device: string; sessions: number; users: number }>;
  countries: Array<{ country: string; sessions: number; users: number }>;
  events: Array<{ event: string; count: number }>;
};

const HISTORY_DAYS = 90;

/** The completed-day window the connector can answer any range from. */
export function ga4HistoryWindow(today = new Date()): { startDate: string; endDate: string; days: number } {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (HISTORY_DAYS - 1));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), days: HISTORY_DAYS };
}

function gaDate(value: string | undefined): string {
  // GA4 returns yyyymmdd for the date dimension.
  return /^\d{8}$/.test(value ?? "") ? `${value!.slice(0, 4)}-${value!.slice(4, 6)}-${value!.slice(6, 8)}` : value ?? "";
}

async function history(
  provider: GoogleCredentialProvider,
  propertyId: string,
  filter?: AnalyticsFilter
): Promise<AnalyticsHistory> {
  const coverage = ga4HistoryWindow();
  const range = { startDate: coverage.startDate, endDate: coverage.endDate };
  // A dimension the property does not collect (for example an event report on
  // a property with no custom events) must not fail the whole sync: totals are
  // still valid and the empty block is honest.
  const safe = (report: () => Promise<{ rows?: ReportRow[] }>) =>
    report().catch(() => ({ rows: [] as ReportRow[] }));
  const [daily, pages, channels, devices, countries, events] = await Promise.all([
    safe(() => runReport(provider, propertyId, {
      dateRanges: [range],
      dimensionFilter: hostFilter(filter),
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "activeUsers" },
        { name: "screenPageViews" },
        { name: "eventCount" },
      ],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: HISTORY_DAYS,
    })),
    safe(() => runReport(provider, propertyId, {
      dateRanges: [range],
      dimensionFilter: hostFilter(filter),
      dimensions: [{ name: "landingPagePlusQueryString" }],
      metrics: [{ name: "screenPageViews" }, { name: "sessions" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 20,
    })),
    safe(() => runReport(provider, propertyId, {
      dateRanges: [range],
      dimensionFilter: hostFilter(filter),
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "engagementRate" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 12,
    })),
    safe(() => runReport(provider, propertyId, {
      dateRanges: [range],
      dimensionFilter: hostFilter(filter),
      dimensions: [{ name: "deviceCategory" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 10,
    })),
    safe(() => runReport(provider, propertyId, {
      dateRanges: [range],
      dimensionFilter: hostFilter(filter),
      dimensions: [{ name: "country" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 15,
    })),
    safe(() => runReport(provider, propertyId, {
      dateRanges: [range],
      dimensionFilter: hostFilter(filter),
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }],
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: 15,
    })),
  ]);
  return {
    coverage,
    daily: (daily.rows ?? []).map((row) => ({
      date: gaDate(row.dimensionValues?.[0]?.value),
      sessions: Math.round(value(row, 0)),
      activeUsers: Math.round(value(row, 1)),
      screenPageViews: Math.round(value(row, 2)),
      eventCount: Math.round(value(row, 3)),
    })),
    pages: (pages.rows ?? []).map((row) => ({
      path: row.dimensionValues?.[0]?.value ?? "",
      views: Math.round(value(row, 0)),
      sessions: Math.round(value(row, 1)),
    })),
    channels: (channels.rows ?? []).map((row) => ({
      channel: row.dimensionValues?.[0]?.value || "(not set)",
      sessions: Math.round(value(row, 0)),
      users: Math.round(value(row, 1)),
      engagementRate: Math.round(value(row, 2) * 10_000) / 10_000,
    })),
    devices: (devices.rows ?? []).map((row) => ({
      device: row.dimensionValues?.[0]?.value || "(not set)",
      sessions: Math.round(value(row, 0)),
      users: Math.round(value(row, 1)),
    })),
    countries: (countries.rows ?? []).map((row) => ({
      country: row.dimensionValues?.[0]?.value || "(not set)",
      sessions: Math.round(value(row, 0)),
      users: Math.round(value(row, 1)),
    })),
    events: (events.rows ?? []).map((row) => ({
      event: row.dimensionValues?.[0]?.value || "(not set)",
      count: Math.round(value(row, 0)),
    })),
  };
}

function percentChange(current: number, previous: number): number | null {
  return previous ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
}

export async function fetchAnalyticsSummary(
  provider: GoogleCredentialProvider,
  propertyId: string,
  dates: {
    currentStart: string;
    currentEnd: string;
    previousStart: string;
    previousEnd: string;
  },
  filter?: AnalyticsFilter
): Promise<AnalyticsSummary> {
  const [current, previous, pages, trafficSources, queries, captured] = await Promise.all([
    totals(provider, propertyId, dates.currentStart, dates.currentEnd, filter),
    totals(provider, propertyId, dates.previousStart, dates.previousEnd, filter),
    topPages(provider, propertyId, dates.currentStart, dates.currentEnd, filter),
    sources(provider, propertyId, dates.currentStart, dates.currentEnd, filter),
    organicQueries(provider, propertyId, dates.currentStart, dates.currentEnd, filter),
    history(provider, propertyId, filter),
  ]);

  const delta_pct = Object.fromEntries(
    Object.entries(current).map(([name, value]) => [name, percentChange(value, previous[name] ?? 0)])
  );
  return {
    current_week: current,
    previous_week: previous,
    delta_pct,
    top_pages: pages,
    sources: trafficSources,
    organic_queries: queries,
    history: captured,
  };
}
