/**
 * Chat-completions client with backoff, used by research synthesis and business
 * knowledge extraction.
 *
 * The provider rate-limits (HTTP 429) under bursts, and the previous code treated
 * that as terminal: a research run failed with "rate-limited" after a single
 * attempt. This retries 429/5xx with exponential backoff and jitter, honours
 * `Retry-After`, and serialises calls in-process so a run does not open several
 * requests at once.
 */

export type ChatConfig = { apiKey: string; baseUrl: string; model: string };

export type ChatJsonInput = {
  config: ChatConfig;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Total attempts including the first. */
  attempts?: number;
};

export class ChatError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ChatError";
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialise calls: one request in flight per process. */
function serialise<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 90_000);
  // Upstream limits are per-minute, so the first retries are short and the later
  // ones wait long enough for a window to reset.
  return Math.min(2 ** attempt * 2_000, 60_000) + Math.floor(Math.random() * 1_000);
}

/** One chat completion that returns parsed JSON, retrying transient failures. */
export async function chatJson(input: ChatJsonInput): Promise<unknown> {
  const attempts = Math.max(1, Math.min(input.attempts ?? 5, 6));
  let lastError: Error = new ChatError("The model could not be reached");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await serialise(async () => {
        const response = await fetch(`${input.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${input.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: input.config.model,
            temperature: input.temperature ?? 0.2,
            max_tokens: input.maxTokens ?? 3_000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.user },
            ],
          }),
          signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
        });

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const body = (await response.text().catch(() => "")).slice(0, 200);
          throw new ChatError(
            `The model is ${response.status === 429 ? "rate-limited" : "unavailable"} (HTTP ${response.status})${body ? `: ${body}` : ""}`,
            response.status,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : undefined
          );
        }
        if (!response.ok) {
          throw new ChatError(`The model returned HTTP ${response.status}`, response.status);
        }

        const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new ChatError("The model returned an empty response");
        }
        return parseJson(content);
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new ChatError(String(error));
      lastError = failure;
      // A timeout is transient like a 5xx: the upstream was slow, not wrong.
      const timedOut = failure.name === "TimeoutError" || /aborted|timeout/i.test(failure.message);
      const retryable = timedOut || (failure instanceof ChatError && (failure.status === 429 || (failure.status ?? 0) >= 500));
      if (!retryable) throw failure;
      if (attempt < attempts - 1) await sleep(backoffMs(attempt, failure.retryAfterMs));
    }
  }
  throw lastError;
}

/** JSON with fences or trailing prose is common; take the balanced object. */
export function parseJson(content: string): unknown {
  const trimmed = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new ChatError("The model returned non-JSON content");
  }
}
