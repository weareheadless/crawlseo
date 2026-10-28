import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findGrant } = vi.hoisted(() => ({ findGrant: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { projectApiKeyGrant: { findFirst: findGrant } } }));
vi.mock("@/lib/encryption", () => ({
  decrypt: (value: string) => value,
  decryptCredential: (value: string) => value,
}));

import { evaluateGoogleAiOverviewQuestion } from "@/lib/aeo/google-ai-overview";

const input = {
  projectId: "project-1",
  question: "Best artisan bakery in Paris?",
  locale: { languageCode: "fr", locationCode: 2250 },
  device: "mobile" as const,
  brand: "Maison Exemple",
  aliases: ["Exemple Bakery"],
};
const credentials = {
  apiKey: { encryptedLogin: "login", encryptedPassword: "password" },
  providerCredential: null,
};
function ok(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200 });
}
function serp(items: unknown[]) {
  return { status_code: 20000, tasks: [{ id: "task-abc", status_code: 20000, cost: 0.001, result: [{ items }] }] };
}

describe("Google AI Overview evaluation", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    findGrant.mockResolvedValue(credentials);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes overview text and deduplicated citations/domains and sends pinned params", async () => {
    fetchMock.mockResolvedValue(ok(serp([{ type: "ai_overview", text: "Maison Exemple is recommended.", references: [
      { url: "https://www.example.com/source" }, { url: "https://www.example.com/source" }, { url: "https://other.test/page" },
    ] }])));
    const result = await evaluateGoogleAiOverviewQuestion(input);
    expect(result).toMatchObject({ state: "succeeded", brandPresent: true, costMicros: 1000, taskId: "task-abc" });
    expect(result.citations).toEqual(["https://www.example.com/source", "https://other.test/page"]);
    expect(result.referencedDomains).toEqual(["example.com", "other.test"]);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/serp/google/organic/live/advanced");
    expect(JSON.parse(String(options.body))[0]).toMatchObject({ keyword: input.question, language_code: "fr", location_code: 2250, device: "mobile", os: "android" });
  });

  it("returns overview_absent distinctly from brand absence", async () => {
    fetchMock.mockResolvedValue(ok(serp([{ type: "organic", title: "A result" }])));
    const result = await evaluateGoogleAiOverviewQuestion(input);
    expect(result.state).toBe("overview_absent");
    expect(result.brandPresent).toBeNull();
    expect(result.answerText).toBeNull();
  });

  it("marks brand absent inside a present overview", async () => {
    fetchMock.mockResolvedValue(ok(serp([{ type: "ai_overview", text: "Try the wonderful boulangerie near the river." }])));
    expect((await evaluateGoogleAiOverviewQuestion(input)).brandPresent).toBe(false);
  });

  it("classifies rate limits and server errors without retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 429 })).mockResolvedValueOnce(new Response("bad", { status: 503 }));
    expect((await evaluateGoogleAiOverviewQuestion(input)).state).toBe("rate_limited");
    expect((await evaluateGoogleAiOverviewQuestion(input)).state).toBe("request_failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies timeout and malformed payload as failures", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "AbortError" }));
    fetchMock.mockResolvedValueOnce(new Response("{no", { status: 200 }));
    expect((await evaluateGoogleAiOverviewQuestion(input)).state).toBe("request_failed");
    expect((await evaluateGoogleAiOverviewQuestion(input)).state).toBe("request_failed");
  });

  it("returns clear configuration failure before making a request when credentials are missing", async () => {
    findGrant.mockResolvedValueOnce({ apiKey: null, providerCredential: null });
    const result = await evaluateGoogleAiOverviewQuestion(input);
    expect(result).toMatchObject({ state: "request_failed", error: expect.stringContaining("credentials are not configured") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
