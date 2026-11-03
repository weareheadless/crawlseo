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

  it("recovers JSON wrapped in prose", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'Here you go:\n{"a":1}\nThanks' } }] })
    );
    await expect(chatJson({ config, system: "s", user: "u" })).resolves.toEqual({ a: 1 });
  });
});
