import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluatePerplexityQuestion } from "../lib/aeo/perplexity";

const input = { question: "Who provides thoughtful design?", locale: "en-GB", brandName: "Acme Studio", brandAliases: ["Acme"] };
const response = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content: string, extra: Record<string, unknown> = {}) => ({ id: "req-1", model: "sonar-pro-2026", choices: [{ message: { content } }], ...extra });

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("evaluatePerplexityQuestion", () => {
  it("parses successful answer, citations, brand names and usage/cost", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-secret");
    const fetchMock = vi.fn().mockResolvedValue(response(completion("Acme Studio is one option.", {
      citations: ["https://example.com/a", "https://example.com/a", "javascript:alert(1)"],
      search_results: [{ url: "https://example.com/b" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.002 },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await evaluatePerplexityQuestion(input);
    expect(result).toMatchObject({ status: "succeeded", answerText: "Acme Studio is one option.", modelVersion: "sonar-pro-2026", requestId: "req-1", citedUrls: ["https://example.com/a", "https://example.com/b"], mentionedBrands: ["Acme Studio", "Acme"], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, costEstimate: 0.002 });
    expect(result.promptText).toContain(input.question);
    expect(result.promptText).not.toContain("must be mentioned");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer test-secret" } });
  });

  it("succeeds without citations", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(completion("A general answer."))));
    expect((await evaluatePerplexityQuestion(input)).citedUrls).toEqual([]);
  });

  it("records no brand match as an explicit empty list", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(completion("A general answer."))));
    expect((await evaluatePerplexityQuestion(input)).mentionedBrands).toEqual([]);
  });

  it("maps rate limits without treating them as absence", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("", 429)));
    expect(await evaluatePerplexityQuestion(input)).toMatchObject({ status: "rate_limited", answerText: null, mentionedBrands: null });
  });

  it("classifies a request timeout", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-secret");
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))));
    expect(await evaluatePerplexityQuestion({ ...input, timeoutMs: 5 })).toMatchObject({ status: "request_failed", reason: "request_timeout", answerText: null });
  });

  it("classifies malformed JSON as a request failure", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("not json")));
    expect(await evaluatePerplexityQuestion(input)).toMatchObject({ status: "request_failed", reason: "invalid_json" });
  });

  it("returns a clear configuration failure without calling fetch", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await evaluatePerplexityQuestion(input)).toMatchObject({ status: "request_failed", reason: expect.stringContaining("PERPLEXITY_API_KEY") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized response bodies", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(completion("A".repeat(500)))));
    expect(await evaluatePerplexityQuestion({ ...input, maxResponseBytes: 100 })).toMatchObject({ status: "request_failed", reason: "response_too_large" });
  });

  it("deduplicates normalized citation URLs", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(completion("Answer", { citations: ["https://example.com/path", "https://example.com/path"] }))));
    expect((await evaluatePerplexityQuestion(input)).citedUrls).toEqual(["https://example.com/path"]);
  });
});
