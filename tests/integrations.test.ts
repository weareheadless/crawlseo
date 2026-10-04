import { describe, expect, it, vi } from "vitest";
import { hashServiceToken } from "@/lib/auth/service-credentials";
import { fetchAnalyticsSummary } from "@/lib/integrations/google/ga4";
import { sourceForJobKind } from "@/lib/jobs/queue";
import { datesForCalendarPeriod, datesForWeeklySummary } from "@/lib/workers/ga4-sync";
import { resolveVerificationMethod } from "@/lib/projects/provision-project";

vi.mock("@/lib/encryption", () => ({
  decryptCredential: vi.fn(() => JSON.stringify({
    client_email: "platform@example.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
  })),
}));

describe("project integrations", () => {
  it("hashes service tokens without retaining the plaintext", () => {
    const first = hashServiceToken("cseo_test-token");
    expect(first).toHaveLength(64);
    expect(first).toBe(hashServiceToken("cseo_test-token"));
    expect(first).not.toContain("cseo_test-token");
  });

  it("maps durable job kinds to auditable sync sources", async () => {
    const { JobKind, SyncSource } = await import("@prisma/client");
    expect(sourceForJobKind(JobKind.GSC_SYNC)).toBe(SyncSource.GSC);
    expect(sourceForJobKind(JobKind.GA4_SYNC)).toBe(SyncSource.GA4);
    expect(sourceForJobKind(JobKind.CRAWL)).toBe(SyncSource.CRAWL);
    expect(sourceForJobKind(JobKind.VITALS_SYNC)).toBe(SyncSource.VITALS);
    expect(sourceForJobKind(JobKind.SEO_RESEARCH)).toBe(SyncSource.DATAFORSEO);
  });

  it("normalizes the GA4 weekly report shape and tolerates an absent organic link", async () => {
    const provider = { getAccessToken: vi.fn(async () => "provider-token") };
    const responses = [
      { metricHeaders: [{ name: "sessions" }, { name: "screenPageViews" }], rows: [{ metricValues: [{ value: "10" }, { value: "20" }] }] },
      { metricHeaders: [{ name: "sessions" }, { name: "screenPageViews" }], rows: [{ metricValues: [{ value: "5" }, { value: "10" }] }] },
      { rows: [{ dimensionValues: [{ value: "/" }], metricValues: [{ value: "20" }] }] },
      { rows: [{ dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "8" }, { value: "7" }] }] },
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-token");
      const payload = responses.shift();
      if (!payload) return new Response("not linked", { status: 400 });
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAnalyticsSummary(provider, "551030734", {
      currentStart: "2026-08-20",
      currentEnd: "2026-08-26",
      previousStart: "2026-08-13",
      previousEnd: "2026-08-19",
    });

    expect(result.current_week.sessions).toBe(10);
    expect(result.delta_pct.sessions).toBe(100);
    expect(result.top_pages).toEqual([{ path: "/", views: 20 }]);
    expect(result.sources).toEqual([{ source: "Organic Search", sessions: 8, users: 7 }]);
    expect(result.organic_queries).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    vi.unstubAllGlobals();
  });

  it("uses completed UTC days for weekly GA4 windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T15:00:00.000Z"));

    expect(datesForWeeklySummary()).toEqual({
      currentStart: "2026-08-20",
      currentEnd: "2026-08-26",
      previousStart: "2026-08-13",
      previousEnd: "2026-08-19",
    });

    vi.useRealTimers();
  });

  it("derives a comparable previous window for a closed calendar month", () => {
    expect(datesForCalendarPeriod("2026-07-01", "2026-07-31")).toEqual({
      currentStart: "2026-07-01",
      currentEnd: "2026-07-31",
      previousStart: "2026-06-01",
      previousEnd: "2026-06-30",
    });
  });

  it("restricts provisioning verification methods and property mismatches", () => {
    expect(
      resolveVerificationMethod(
        { domainVerificationMethod: "verified_gsc" },
        "oceanicvibes",
        "https://oceanicvibes.com/",
        "oceanicvibes.com"
      )
    ).toBe("verified_gsc");

    expect(() =>
      resolveVerificationMethod(
        { domainVerificationMethod: "verified_gsc" },
        "oceanicvibes",
        "https://other.example/",
        "oceanicvibes.com"
      )
    ).toThrowError("Verified GSC property must match the site domain");

    expect(() =>
      resolveVerificationMethod(
        { allowDomainVerificationOverride: true },
        "another-project",
        "https://another-project.example/",
        "another-project.example"
      )
    ).toThrowError("Operator domain verification override is restricted to OceanicVibes");
  });

  it("allows platform service-account authorization for Search Console", async () => {
    const { IntegrationProvider } = await import("@prisma/client");
    const { credentialProviderForGrant } = await import("@/lib/integrations/google/connections");
    const grant = {
      provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
      connection: {
        type: "SERVICE_ACCOUNT",
        metadata: {},
        encryptedCredentials: "not-used",
      },
    } as Parameters<typeof credentialProviderForGrant>[0];

    const provider = await credentialProviderForGrant(grant);
    expect(provider).toBeTruthy();
  });
});
