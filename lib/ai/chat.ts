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

export type ChatAttemptRecord = {
  attempt: number;
  status: "ok" | "error";
  error?: string;
  /** Raw provider text when one was available, even for a failed attempt. */
  responseText?: string | null;
};

export type ChatJsonInput = {
  config: ChatConfig;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Total attempts including the first. */
  attempts?: number;
  /** Absolute epoch-millisecond deadline for the whole call, including queue and backoff. */
  deadlineAt?: number;
  /** Ask the provider for a JSON object. Disable for providers that return an empty body in JSON mode. */
  jsonMode?: boolean;
  /**
   * Called immediately before every transport attempt, inside the serialised
   * queue. Throw to stop before dispatch; the caller uses this to charge a shared
   * budget per actual request.
   */
  beforeAttempt?: () => void;
  /** Observes every transport attempt, including failures and malformed output. */
  onAttempt?: (record: ChatAttemptRecord) => void;
};

export class ChatError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ChatError";
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialise calls: one request in flight per process. */
function serialise<T>(task: () => Promise<T>, deadlineAt?: number): Promise<T> {
  const guarded = async (): Promise<T> => {
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      throw new ChatError("The analysis deadline was exceeded before the request could be dispatched");
    }
    return task();
  };
  const next = queue.then(guarded, guarded);
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

  const deadlineAt = input.deadlineAt;
  // A reasoning model can spend the whole completion budget before writing a
  // single character, which arrives as an empty message with
  // finish_reason "length". Retrying with the same budget repeats the failure,
  // so the budget doubles when that happens.
  let tokenBudget = input.maxTokens ?? 3_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let attemptRecorded = false;
    const record = (entry: ChatAttemptRecord): void => {
      attemptRecorded = true;
      input.onAttempt?.(entry);
    };
    try {
      return await serialise(async () => {
        if (deadlineAt != null && Date.now() >= deadlineAt) {
          throw new ChatError("The analysis deadline was exceeded before the request could be dispatched");
        }
        input.beforeAttempt?.();
        const remaining = deadlineAt != null ? Math.max(1, deadlineAt - Date.now()) : (input.timeoutMs ?? 120_000);
        const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? 120_000, remaining));
        const response = await fetch(`${input.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${input.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: input.config.model,
            temperature: input.temperature ?? 0.2,
            max_tokens: tokenBudget,
            ...(input.jsonMode === false ? {} : { response_format: { type: "json_object" } }),
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.user },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const body = (await response.text().catch(() => "")).slice(0, 200);
          record({ attempt: attempt + 1, status: "error", error: `HTTP ${response.status}`, responseText: body });
          throw new ChatError(
            `The model is ${response.status === 429 ? "rate-limited" : "unavailable"} (HTTP ${response.status})${body ? `: ${body}` : ""}`,
            response.status,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : undefined
          );
        }
        if (!response.ok) {
          const text = (await response.text().catch(() => "")).slice(0, 2_000);
          record({ attempt: attempt + 1, status: "error", error: `HTTP ${response.status}`, responseText: text });
          throw new ChatError(`The model returned HTTP ${response.status}`, response.status);
        }

        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
        };
        const content = body.choices?.[0]?.message?.content;
        const finish = body.choices?.[0]?.finish_reason;
        if (typeof content !== "string" || !content.trim()) {
          record({
            attempt: attempt + 1,
            status: "error",
            error: finish ? `empty response (finish_reason: ${finish})` : "empty response",
            responseText: null,
          });
          throw new ChatError(
            finish === "length"
              ? "The model returned an empty response: it spent the whole token budget before answering"
              : "The model returned an empty response"
          );
        }
        try {
          const parsed = parseJson(content);
          record({ attempt: attempt + 1, status: "ok" });
          return parsed;
        } catch (error) {
          // A JSON.parse failure inside a truncated completion is not the same
          // failure as a model that answered prose: the budget, not the answer,
          // was too small.
          const truncated = finish === "length";
          const message = truncated
            ? `The model returned a truncated JSON response: ${error instanceof Error ? error.message.slice(0, 200) : "unparseable"}`
            : "The model returned non-JSON content";
          record({
            attempt: attempt + 1,
            status: "error",
            error: message,
            responseText: content.slice(0, 4_000),
          });
          throw new ChatError(message);
        }
      }, deadlineAt);
    } catch (error) {
      const failure = error instanceof Error ? error : new ChatError(String(error));
      if (!attemptRecorded) {
        record({ attempt: attempt + 1, status: "error", error: failure.message });
      }
      lastError = failure;
      // A timeout is transient like a 5xx: the upstream was slow, not wrong.
      const timedOut = failure.name === "TimeoutError" || /aborted|timeout/i.test(failure.message);
      // Malformed JSON is often a truncated or fenced answer; one more attempt is
      // cheaper than failing the whole research run.
      const malformed = /non-JSON/i.test(failure.message);
      // An empty or cut-off message is not a refusal: it is a truncated
      // completion, and a larger budget usually answers it.
      const empty = /empty response|truncated JSON/i.test(failure.message);
      if (empty) tokenBudget = Math.min(Math.ceil(tokenBudget * 2), 64_000);
      const retryable = timedOut || malformed || empty || (failure instanceof ChatError && (failure.status === 429 || (failure.status ?? 0) >= 500));
      if (!retryable) throw failure;
      const retryAfterMs = failure instanceof ChatError ? failure.retryAfterMs : undefined;
      if (attempt < attempts - 1) {
        const remaining = deadlineAt != null ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
        if (remaining <= 0) throw new ChatError("The analysis deadline was exceeded before retry");
        await sleep(Math.min(backoffMs(attempt, retryAfterMs), remaining));
      }
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
