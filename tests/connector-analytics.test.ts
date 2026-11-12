import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireConnectorSite: vi.fn(),
  integrationGrant: { findMany: vi.fn() },
  analyticsSnapshot: { findFirst: vi.fn() },
  keyword: { findMany: vi.fn(), count: vi.fn() },
  page: { findMany: vi.fn(), count: vi.fn() },
  syncRun: { findFirst: vi.fn() },
  connectorPrincipal: vi.fn(),
}));

vi.mock("@/lib/connectors/service", () => ({
  requireConnectorSite: mocks.requireConnectorSite,
  ConnectorError: class ConnectorError extends Error { constructor(message: string, readonly status = 400) { super(message); } },
}));
vi.mock("@/lib/db", () => ({ db: mocks }));
vi.mock("@/lib/connectors/auth", () => ({
  connectorPrincipal: mocks.connectorPrincipal,
  isConnectorResponse: (value: unknown) => Boolean(value && typeof value === "object" && "response" in value),
}));

import { getConnectorAnalytics } from "@/lib/connectors/analytics";
import { GET } from "@/app/api/connector/v1/analytics/route";
import { ConnectorError } from "@/lib/connectors/service";

const principal = { credentialId: "credential-1", servicePrincipalId: "principal-1", projectId: "project-1", workspaceId: "workspace-1", scopes: ["connector:read"] };
const site = { id: "site-1", connectorBinding: { status: "ACTIVE" } };

describe("connector analytics read projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireConnectorSite.mockResolvedValue(site);
    mocks.integrationGrant.findMany.mockResolvedValue([]);
    mocks.analyticsSnapshot.findFirst.mockResolvedValue(null);
    mocks.keyword.findMany.mockResolvedValue([]);
    mocks.keyword.count.mockResolvedValue(0);
    mocks.page.findMany.mockResolvedValue([]);
    mocks.page.count.mockResolvedValue(0);
    mocks.syncRun.findFirst.mockResolvedValue(null);
  });

  it("requires explicit tenant site scope and returns missing data as unavailable, not zeros", async () => {
    const result = await getConnectorAnalytics(principal, "site-1");
    expect(mocks.requireConnectorSite).toHaveBeenCalledWith(principal, "site-1");
    expect(result.ga4).toMatchObject({ status: "missing", propertyId: null, data: null, connection: { status: "unconnected" } });
    expect(result.gsc).toMatchObject({ status: "missing", propertyId: null, queries: [], pages: [], connection: { status: "unconnected" } });
    expect(result.ga4.data).toBeNull();
  });

  it("projects saved freshness, coverage, property IDs and bounded GSC rows", async () => {
    mocks.integrationGrant.findMany.mockResolvedValue([
      { id: "ga4-grant", provider: "GOOGLE_ANALYTICS", status: "ACTIVE", externalResourceId: "properties/123", safeErrorCode: null, lastSuccessfulAt: new Date("2026-11-09T00:00:00Z"), updatedAt: new Date("2026-11-09T00:00:00Z"), connection: { status: "ACTIVE" } },
      { id: "ga4-revoked", provider: "GOOGLE_ANALYTICS", status: "REVOKED", externalResourceId: "properties/old", safeErrorCode: null, lastSuccessfulAt: new Date("2026-11-10T00:00:00Z"), updatedAt: new Date("2026-11-10T00:00:00Z"), connection: { status: "REVOKED" } },
      { id: "gsc-grant", provider: "GOOGLE_SEARCH_CONSOLE", status: "ACTIVE", externalResourceId: "sc-domain:example.test", safeErrorCode: null, lastSuccessfulAt: new Date("2026-11-09T00:00:00Z"), updatedAt: new Date("2026-11-09T00:00:00Z"), connection: { status: "ACTIVE" } },
      { id: "gsc-revoked", provider: "GOOGLE_SEARCH_CONSOLE", status: "REVOKED", externalResourceId: "sc-domain:old.test", safeErrorCode: null, lastSuccessfulAt: new Date("2026-11-10T00:00:00Z"), updatedAt: new Date("2026-11-10T00:00:00Z"), connection: { status: "REVOKED" } },
    ]);
    mocks.analyticsSnapshot.findFirst.mockResolvedValue({ id: "snap-1", capturedAt: new Date("2026-11-10T00:00:00Z"), periodStart: new Date("2026-11-01T00:00:00Z"), periodEnd: new Date("2026-11-07T23:59:59Z"), data: { current_week: { activeUsers: 8, sessions: 12 }, coverage: { startDate: "2026-11-01", endDate: "2026-11-07" } } });
    mocks.keyword.findMany.mockResolvedValue([{ query: "sample", date: new Date("2026-11-06T00:00:00Z"), clicks: 2, impressions: 20, ctr: 0.1, position: 3.2, page: "/" }]);
    mocks.keyword.count.mockResolvedValue(1);
    mocks.page.findMany.mockResolvedValue([{ url: "https://example.test/", date: new Date("2026-11-06T00:00:00Z"), clicks: 2, impressions: 20, ctr: 0.1, position: 3.2 }]);
    mocks.page.count.mockResolvedValue(1);
    const gscRun = { status: "COMPLETED", finishedAt: new Date("2026-11-10T00:00:00Z"), createdAt: new Date("2026-11-10T00:00:00Z"), errorCode: null,
      metadata: { coverage: { startDate: "2026-11-01", endDate: "2026-11-07" } } };
    mocks.syncRun.findFirst.mockResolvedValueOnce(gscRun).mockResolvedValueOnce(null).mockResolvedValueOnce(gscRun);
    const result = await getConnectorAnalytics(principal, "site-1");
    expect(result.ga4).toMatchObject({ status: "available", propertyId: "properties/123", observedAt: "2026-11-10T00:00:00.000Z", coverage: { startDate: "2026-11-01", endDate: "2026-11-07" }, connection: { status: "connected" }, latestSync: { status: "none" } });
    expect(result.gsc).toMatchObject({ status: "available", propertyId: "sc-domain:example.test", observedAt: "2026-11-10T00:00:00.000Z",
      coverage: { startDate: "2026-11-01", endDate: "2026-11-07" }, queries: [{ query: "sample", clicks: 2 }], connection: { status: "connected" }, latestSync: { status: "completed" } });
  });

  it("keeps persisted metrics but independently reports errored/revoked connection and latest failed sync", async () => {
    mocks.integrationGrant.findMany.mockResolvedValue([
      { id: "ga4-error", provider: "GOOGLE_ANALYTICS", status: "ERROR", externalResourceId: "properties/123", safeErrorCode: "GA4_AUTH_FAILED", lastSuccessfulAt: new Date("2026-11-05T00:00:00Z"), updatedAt: new Date("2026-11-06T00:00:00Z"), connection: { status: "ACTIVE" } },
      { id: "gsc-revoked", provider: "GOOGLE_SEARCH_CONSOLE", status: "REVOKED", externalResourceId: "sc-domain:old.test", safeErrorCode: null, lastSuccessfulAt: new Date("2026-11-05T00:00:00Z"), updatedAt: new Date("2026-11-06T00:00:00Z"), connection: { status: "REVOKED" } },
    ]);
    mocks.analyticsSnapshot.findFirst.mockResolvedValue({ id: "snap-old", capturedAt: new Date("2026-11-06T00:00:00Z"), periodStart: new Date("2026-11-01T00:00:00Z"), periodEnd: new Date("2026-11-07T23:59:59Z"), data: { current_week: { activeUsers: 8 }, coverage: { startDate: "2026-11-02", endDate: "2026-11-06" } } });
    mocks.keyword.count.mockResolvedValue(2);
    mocks.keyword.findMany.mockResolvedValue([{ query: "saved", date: new Date("2026-11-06T00:00:00Z"), clicks: 1, impressions: 4, ctr: .25, position: 2, page: "/" }]);
    mocks.syncRun.findFirst.mockResolvedValueOnce({ status: "FAILED", finishedAt: new Date("2026-11-11T00:00:00Z"), errorCode: "GSC_SYNC_FAILED", metadata: {} })
      .mockResolvedValueOnce({ status: "FAILED", finishedAt: new Date("2026-11-12T00:00:00Z"), errorCode: "GA4_SYNC_FAILED", metadata: {} })
      .mockResolvedValueOnce({ status: "COMPLETED", finishedAt: new Date("2026-11-08T00:00:00Z"), errorCode: null, metadata: { coverage: { startDate: "2026-11-02", endDate: "2026-11-06" } } });
    const result = await getConnectorAnalytics(principal, "site-1");
    expect(result.ga4).toMatchObject({ status: "available", data: { current_week: { activeUsers: 8 } }, connection: { status: "error", errorCode: "GA4_AUTH_FAILED" }, latestSync: { status: "failed", errorCode: "GA4_SYNC_FAILED" } });
    expect(result.gsc).toMatchObject({ status: "available", connection: { status: "revoked" }, latestSync: { status: "failed", errorCode: "GSC_SYNC_FAILED" }, coverage: { startDate: "2026-11-02", endDate: "2026-11-06" } });
  });

  it("does not claim malformed GA4 snapshots are available", async () => {
    mocks.integrationGrant.findMany.mockResolvedValue([{ id: "ga4", provider: "GOOGLE_ANALYTICS", status: "ACTIVE", externalResourceId: "properties/1", safeErrorCode: null, lastSuccessfulAt: null, updatedAt: new Date(), connection: { status: "ACTIVE" } }]);
    mocks.analyticsSnapshot.findFirst.mockResolvedValue({ id: "empty", capturedAt: new Date(), periodStart: new Date("2026-11-01T00:00:00Z"), periodEnd: new Date("2026-11-07T00:00:00Z"), data: {} });
    const result = await getConnectorAnalytics(principal, "site-1");
    expect(result.ga4).toMatchObject({ status: "invalid", data: null, snapshotId: "empty", coverage: { startDate: "2026-11-01", endDate: "2026-11-07" }, connection: { status: "connected" } });
  });

  it("does not pick another credential/property when grant selection is ambiguous", async () => {
    mocks.integrationGrant.findMany.mockResolvedValue([
      { id: "one", provider: "GOOGLE_ANALYTICS", status: "ACTIVE", connection: { status: "ACTIVE" } },
      { id: "two", provider: "GOOGLE_ANALYTICS", status: "ERROR", connection: { status: "ACTIVE" } },
    ]);
    const result = await getConnectorAnalytics(principal, "site-1");
    expect(result.ga4).toMatchObject({ propertyId: null,
      connection: { status: "ambiguous", errorCode: "MULTIPLE_GOOGLE_GRANTS" } });
    expect(result.gsc.connection.status).toBe("unconnected");
  });

  it("projects known numeric metrics and rows without arbitrary nested snapshot fields", async () => {
    mocks.analyticsSnapshot.findFirst.mockResolvedValue({ id: "snap", capturedAt: new Date("2026-11-10"),
      periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-11-07"), data: {
        current_week: { activeUsers: 0, token: "excluded" }, top_pages: [{ path: "/", views: 0, secret: "excluded" }],
        credential: "excluded",
      } });
    const result = await getConnectorAnalytics(principal, "site-1");
    expect(result.ga4.data).toEqual({ current_week: { activeUsers: 0 }, top_pages: [{ path: "/", views: 0 }] });
  });

  it.each([{ startDate: "2026-02-30", endDate: "2026-03-01" }, { startDate: "2026-11-01" },
    { startDate: "2026-11-02", endDate: "2026-11-01" }, { startDate: "2024-01-01", endDate: "2026-01-01" }])(
    "rejects invalid/unpaired/overlong ranges", async (range) => {
      await expect(getConnectorAnalytics(principal, "site-1", range)).rejects.toMatchObject({ status: 400 });
      expect(mocks.keyword.findMany).not.toHaveBeenCalled();
    });

  it("authenticates connector:read and rejects a missing siteId", async () => {
    mocks.connectorPrincipal.mockResolvedValue({ principal });
    const response = await GET(new Request("https://app.test/api/connector/v1/analytics"));
    expect(response.status).toBe(400);
    expect(mocks.requireConnectorSite).not.toHaveBeenCalled();
  });

  it("returns authentication failures before accessing analytics data", async () => {
    mocks.connectorPrincipal.mockResolvedValue({ response: Response.json({ error: "Forbidden" }, { status: 403 }) });
    const response = await GET(new Request("https://app.test/api/connector/v1/analytics?siteId=site-1"));
    expect(response.status).toBe(403);
    expect(mocks.requireConnectorSite).not.toHaveBeenCalled();
  });

  it("enforces project/site scope through the shared active-site guard", async () => {
    mocks.connectorPrincipal.mockResolvedValue({ principal });
    mocks.requireConnectorSite.mockRejectedValue(new ConnectorError("Project site not found", 404));
    const response = await GET(new Request("https://app.test/api/connector/v1/analytics?siteId=foreign-site"));
    expect(response.status).toBe(404);
    expect(mocks.requireConnectorSite).toHaveBeenCalledWith(principal, "foreign-site");
  });
});
