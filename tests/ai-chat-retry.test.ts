import { afterEach, describe, expect, it, vi } from "vitest";

import { chatJson, ChatError } from "@/lib/ai/chat";

const config = { apiKey: "k", baseUrl: "https://llm.test/v1", model: "m" };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("chat client backoff", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries a 429 and returns the parsed object", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "0.001" } }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }));

    const result = await chatJson({ config, system: "s", user: "u", attempts: 3 });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget with the provider's status", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("busy", { status: 429, headers: { "retry-after": "0.001" } }));

    await expect(chatJson({ config, system: "s", user: "u", attempts: 2 })).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(chatJson({ config, system: "s", user: "u", attempts: 4 })).rejects.toBeInstanceOf(ChatError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an empty reasoning response with a larger token budget", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] })
      )
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }));

    const result = await chatJson({ config, system: "s", user: "u", maxTokens: 1_000, attempts: 2 });
    expect(result).toEqual({ ok: true });
    const first = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).max_tokens;
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).max_tokens;
    expect(first).toBe(1_000);
    expect(second).toBe(2_000);
  });

  it("retries a truncated JSON answer with a larger budget", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '{"proposals":[{"title":"a"' }, finish_reason: "length" }] })
      )
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{"proposals":[]}' } }] }));

    const result = await chatJson({ config, system: "s", user: "u", maxTokens: 4_000, attempts: 2 });
    expect(result).toEqual({ proposals: [] });
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).max_tokens;
    expect(second).toBe(8_000);
  });

  it("recovers JSON wrapped in prose", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'Here you go:\n{"a":1}\nThanks' } }] })
    );
    await expect(chatJson({ config, system: "s", user: "u" })).resolves.toEqual({ a: 1 });
  });

  it("does not retry a 429 that means the key is out of credit", async () => {
    // OpenRouter answers an exhausted balance with HTTP 429 and
    // `code: "credit_balance_exhausted"`, not 402. Treating it as a rate limit
    // spent four attempts and minutes of backoff to report a condition no delay
    // can fix, and the run surfaced it as a model problem.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "You have no credits remaining. Add credits to continue using the API.",
            type: "insufficient_quota",
            code: "credit_balance_exhausted",
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } }
      )
    );

    const error = (await chatJson({ config, system: "s", user: "u", attempts: 4 }).catch((thrown) => thrown)) as ChatError;
    expect(error).toBeInstanceOf(ChatError);
    expect(error.billing).toBe(true);
    expect(error.message).toMatch(/no credit/);
    // One call: no backoff, because waiting cannot add credit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a plain 429, which is a rate limit", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0.001" } }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }));

    await expect(chatJson({ config, system: "s", user: "u", attempts: 3 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
