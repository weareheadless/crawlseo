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
};

type ReportRow = {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
};

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
  endDate: string
): Promise<Record<string, number>> {
  const result = await runReport(provider, propertyId, {
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: "activeUsers" },
      { name: "totalUsers" },
      { name: "sessions" },
      { name: "screenPageViews" },
    ],
  });
  const row = result.rows?.[0];
  return Object.fromEntries(metricNames(result).map((name, index) => [name, value(row, index)]));
}

async function topPages(
  provider: GoogleCredentialProvider,
  propertyId: string,
  startDate: string,
  endDate: string
): Promise<AnalyticsSummary["top_pages"]> {
  const result = await runReport(provider, propertyId, {
    dateRanges: [{ startDate, endDate }],
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
  endDate: string
): Promise<AnalyticsSummary["sources"]> {
  const result = await runReport(provider, propertyId, {
    dateRanges: [{ startDate, endDate }],
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
  endDate: string
): Promise<AnalyticsSummary["organic_queries"]> {
  try {
    const result = await runReport(provider, propertyId, {
      dateRanges: [{ startDate, endDate }],
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
  }
): Promise<AnalyticsSummary> {
  const [current, previous, pages, trafficSources, queries] = await Promise.all([
    totals(provider, propertyId, dates.currentStart, dates.currentEnd),
    totals(provider, propertyId, dates.previousStart, dates.previousEnd),
    topPages(provider, propertyId, dates.currentStart, dates.currentEnd),
    sources(provider, propertyId, dates.currentStart, dates.currentEnd),
    organicQueries(provider, propertyId, dates.currentStart, dates.currentEnd),
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
  };
}
