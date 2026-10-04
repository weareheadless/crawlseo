import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  seoResearchTask: { findFirst: vi.fn() },
  projectApiKeyGrant: { findFirst: vi.fn(), update: vi.fn() },
}));
const mockEncryption = vi.hoisted(() => ({
  decrypt: vi.fn(),
  decryptCredential: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/encryption", () => mockEncryption);

import {
  executeDataForSeoKeywordOverview,
  executeDataForSeoOperation,
  executeDataForSeoOrganicSerp,
  executeDataForSeoRelatedKeywords,
  getDataForSeoLocaleCatalog,
  parseDataForSeoLocaleCatalog,
} from "@/lib/dataforseo/client";

describe("DataForSEO grant resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.seoResearchTask.findFirst.mockResolvedValue({ id: "task-1" });
    mockDb.projectApiKeyGrant.findFirst.mockResolvedValue({
      id: "grant-1",
      apiKey: null,
      providerCredential: {
        status: "ACTIVE",
        encryptedLogin: "platform-login-ciphertext",
        encryptedPassword: "platform-password-ciphertext",
      },
    });
    mockDb.projectApiKeyGrant.update.mockResolvedValue({});
    mockEncryption.decryptCredential.mockImplementation((value: string) => `decrypted:${value}`);
    mockEncryption.decrypt.mockImplementation((value: string) => `legacy:${value}`);
  });

  it("uses the explicitly granted platform credential without a user lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status_code: 20000,
        tasks: [
          {
            id: "provider-task-1",
            status_code: 20000,
            cost: 0.001,
            result: [
              {
                metrics: {
                  organic: {
                    count: 12,
                    etv: 34,
                    estimated_paid_traffic_cost: 5,
                    backlinks: 6,
                    referring_domains: 7,
                  },
                },
              },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeDataForSeoOperation({
        projectId: "project-1",
        researchRunId: "run-1",
        taskId: "task-1",
        operation: {
          kind: "DOMAIN_OVERVIEW",
          domain: "site.example",
          languageCode: "en",
          locationCode: 2840,
        },
      })
    ).resolves.toMatchObject({
      kind: "DOMAIN_OVERVIEW",
      providerTaskId: "provider-task-1",
      result: { organicKeywords: 12 },
    });

    expect(mockEncryption.decryptCredential).toHaveBeenCalledWith("platform-login-ciphertext");
    expect(mockEncryption.decryptCredential).toHaveBeenCalledWith("platform-password-ciphertext");
    expect(mockEncryption.decrypt).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("decrypted:platform-login-ciphertext:decrypted:platform-password-ciphertext").toString("base64")}`,
        }),
      })
    );
  });

  it("normalizes one related-keywords response and preserves provider metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status_code: 20000,
        tasks: [{
          id: "provider-task-2",
          status_code: 20000,
          cost: 0.002,
          result: [{
            items: [{
              keyword_data: {
                keyword: "mouthfill technique",
                keyword_info: {
                  search_volume: 90,
                  keyword_difficulty: 18,
                  cpc: 0.4,
                  competition: 0.2,
                  monthly_searches: [{ search_volume: 90 }, { search_volume: 110 }],
                },
              },
            }],
          }],
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeDataForSeoRelatedKeywords({
        projectId: "project-1",
        seed: "mouthfill",
        languageCode: "en",
        locationCode: 2840,
      })
    ).resolves.toEqual({
      providerTaskId: "provider-task-2",
      costMicros: 2000,
      result: [{
        keyword: "mouthfill technique",
        volume: 90,
        difficulty: 18,
        cpc: 0.4,
        competition: 0.2,
        trend: [90, 110],
      }],
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([{
      keyword: "mouthfill",
      language_code: "en",
      location_code: 2840,
      depth: 1,
      limit: 50,
    }]);
  });

  it("parses only country-level Google locales from the provider catalog", () => {
    expect(parseDataForSeoLocaleCatalog({
      status_code: 20000,
      tasks: [{
        status_code: 20000,
        result: [
          {
            location_code: 2484,
            location_type: "Country",
            country_iso_code: "MX",
            available_languages: [
              { language_code: "es", available_sources: ["google"] },
              { language_code: "en", available_sources: ["bing"] },
            ],
          },
          {
            location_code: 999,
            location_type: "City",
            country_iso_code: "MX",
            available_languages: [{ language_code: "es", available_sources: ["google"] }],
          },
        ],
      }],
    })).toEqual([{ country: "MX", languageCode: "es", locationCode: 2484 }]);
  });

  it("loads the non-billable locale catalog with the project credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status_code: 20000,
        tasks: [{
          status_code: 20000,
          result: [{
            location_code: 2840,
            location_type: "Country",
            country_iso_code: "US",
            available_languages: [{ language_code: "en", available_sources: ["google"] }],
          }],
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDataForSeoLocaleCatalog("project-1")).resolves.toEqual([
      { country: "US", languageCode: "en", locationCode: 2840 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dataforseo.com/v3/dataforseo_labs/locations_and_languages",
      expect.objectContaining({ method: "GET" })
    );
    expect(mockDb.projectApiKeyGrant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "grant-1" } })
    );
  });

  it("rejects a task-level provider error even when the envelope is successful", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status_code: 20000,
        tasks: [{
          id: "provider-task-error",
          status_code: 40203,
          status_message: "Not enough money",
          cost: 0,
          result: [],
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeDataForSeoRelatedKeywords({
        projectId: "project-1",
        seed: "mouthfill",
        languageCode: "en",
        locationCode: 2840,
      })
    ).rejects.toThrow("DATAFORSEO_TASK_40203: Not enough money");
  });
});

describe("DataForSEO candidate overview contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.projectApiKeyGrant.findFirst.mockResolvedValue({
      id: "grant-1",
      apiKey: null,
      providerCredential: {
        status: "ACTIVE",
        encryptedLogin: "platform-login-ciphertext",
        encryptedPassword: "platform-password-ciphertext",
      },
    });
    mockDb.projectApiKeyGrant.update.mockResolvedValue({});
    mockEncryption.decryptCredential.mockImplementation((value: string) => `decrypted:${value}`);
    mockEncryption.decrypt.mockImplementation((value: string) => `legacy:${value}`);
  });

  it("sends one batched overview task with every candidate and normalizes exact metrics", async () => {
    const candidates = ["freediving playa del carmen", "cenote freediving for beginners"];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status_code: 20000,
        tasks: [{
          id: "provider-overview-1",
          status_code: 20000,
          cost: 0.002,
          result: [{
            items: [{
              keyword: "freediving playa del carmen",
              keyword_info: {
                search_volume: 20,
                competition: 0.63,
                competition_level: "MEDIUM",
                cpc: 0,
                monthly_searches: [{ search_volume: 20 }, { search_volume: 30 }],
              },
              keyword_properties: { keyword_difficulty: 0 },
              search_intent_info: { main_intent: "informational" },
            }],
          }],
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeDataForSeoKeywordOverview({
        projectId: "project-1",
        keywords: candidates,
        languageCode: "en",
        locationCode: 2840,
      })
    ).resolves.toEqual({
      providerTaskId: "provider-overview-1",
      costMicros: 2000,
      result: [{
        keyword: "freediving playa del carmen",
        volume: 20,
        difficulty: 0,
        cpc: 0,
        competition: 0.63,
        competitionLevel: "MEDIUM",
        intent: "informational",
        trend: [20, 30],
      }],
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([{
      keywords: candidates,
      language_code: "en",
      location_code: 2840,
      include_serp_info: false,
      include_clickstream_data: false,
    }]);
  });
});

describe("DataForSEO organic SERP contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.projectApiKeyGrant.findFirst.mockResolvedValue({
      id: "grant-1",
      apiKey: null,
      providerCredential: {
        status: "ACTIVE",
        encryptedLogin: "platform-login-ciphertext",
        encryptedPassword: "platform-password-ciphertext",
      },
    });
    mockDb.projectApiKeyGrant.update.mockResolvedValue({});
    mockEncryption.decryptCredential.mockImplementation((value: string) => `decrypted:${value}`);
    mockEncryption.decrypt.mockImplementation((value: string) => `legacy:${value}`);
  });

  it("requests a bounded desktop organic SERP and normalizes the compact evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status_code: 20000,
        tasks: [{
          id: "provider-serp-1",
          status_code: 20000,
          cost: 0.001,
          result: [{
            keyword: "freediving playa del carmen",
            datetime: "2026-08-29 10:00:00 +00:00",
            item_types: ["organic", "people_also_ask", "related_searches", "local_pack"],
            items: [
              { type: "organic", rank_group: 1, domain: "school.example", title: "Freediving school", url: "https://school.example", description: "Courses." },
              { type: "people_also_ask", items: [{ title: "Is freediving safe?", url: "https://example.com/safe" }] },
              { type: "related_searches", items: [{ title: "cenote freediving" }] },
              { type: "local_pack", items: [{ title: "Playa Freediving", url: "https://map.example", rating: 4.8 }] },
            ],
          }],
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeDataForSeoOrganicSerp({
        projectId: "project-1",
        keyword: "freediving playa del carmen",
        languageCode: "en",
        locationCode: 2840,
      })
    ).resolves.toEqual({
      providerTaskId: "provider-serp-1",
      costMicros: 1000,
      result: {
        query: "freediving playa del carmen",
        checkedAt: "2026-08-29 10:00:00 +00:00",
        itemTypes: ["organic", "people_also_ask", "related_searches", "local_pack"],
        organic: [{
          rank: 1,
          domain: "school.example",
          title: "Freediving school",
          url: "https://school.example",
          description: "Courses.",
        }],
        peopleAlsoAsk: [{ question: "Is freediving safe?", url: "https://example.com/safe" }],
        relatedSearches: ["cenote freediving"],
        localPack: [{ title: "Playa Freediving", url: "https://map.example", rating: 4.8 }],
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([{
      keyword: "freediving playa del carmen",
      language_code: "en",
      location_code: 2840,
      device: "desktop",
      os: "windows",
      depth: 10,
      group_organic_results: true,
    }]);
  });
});
