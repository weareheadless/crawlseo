const API_URL = "https://api.perplexity.ai/chat/completions";
const DEFAULT_MODEL = "sonar";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const STABLE_INSTRUCTION = "Answer the question accurately and neutrally. Do not assume a particular business or brand should be recommended; include one only if it is genuinely relevant. Be concise and cite sources when available.";

export type PerplexityResult = {
  status: "succeeded" | "answer_absent" | "request_failed" | "rate_limited" | "over_budget";
  promptText: string;
  answerText: string | null;
  modelVersion: string | null;
  requestId: string | null;
  citedUrls: string[];
  mentionedBrands: string[] | null;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
  costEstimate: number | null;
  reason?: string;
};

export type EvaluatePerplexityQuestionInput = {
  question: string;
  locale: string;
  brandName?: string | null;
  brandAliases?: string[];
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

function promptFor(question: string, locale: string): string {
  return `${STABLE_INSTRUCTION}\nRespond in ${locale}.\n\nQuestion: ${question}`;
}

function emptyResult(status: PerplexityResult["status"], promptText: string, reason?: string): PerplexityResult {
  return { status, promptText, answerText: null, modelVersion: null, requestId: null, citedUrls: [], mentionedBrands: null, usage: null, costEstimate: null, ...(reason ? { reason } : {}) };
}

function validUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function citationsFrom(data: Record<string, unknown>): string[] {
  const values: unknown[] = [];
  if (Array.isArray(data.citations)) values.push(...data.citations);
  if (Array.isArray(data.search_results)) values.push(...data.search_results);
  const urls = values.map((item) => validUrl(typeof item === "string" ? item : item && typeof item === "object" ? (item as Record<string, unknown>).url : null)).filter((url): url is string => Boolean(url));
  return [...new Set(urls)];
}

function detectedBrands(answer: string, input: EvaluatePerplexityQuestionInput): string[] | null {
  const candidates = [...new Set([input.brandName, ...(input.brandAliases ?? [])].filter((name): name is string => Boolean(name?.trim())).map((name) => name.trim()))];
  if (!candidates.length) return null;
  return candidates.filter((name) => answer.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

/** Requests one Perplexity answer. Credentials are read only from server process env. */
export async function evaluatePerplexityQuestion(input: EvaluatePerplexityQuestionInput): Promise<PerplexityResult> {
  const promptText = promptFor(input.question, input.locale);
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return emptyResult("request_failed", promptText, "PERPLEXITY_API_KEY is not configured on the server.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: input.model ?? DEFAULT_MODEL, messages: [{ role: "user", content: promptText }], stream: false }),
        signal: controller.signal,
      });
    } catch (error) {
      return emptyResult("request_failed", promptText, controller.signal.aborted ? "request_timeout" : error instanceof Error ? error.message : "network_error");
    }
    if (response.status === 429) return emptyResult("rate_limited", promptText, "HTTP 429");
    if (response.status === 402) return emptyResult("over_budget", promptText, "HTTP 402");
    if (!response.ok) return emptyResult("request_failed", promptText, `HTTP ${response.status}`);

    let raw: string;
    try { raw = await readBounded(response, input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES); }
    catch (error) { return emptyResult("request_failed", promptText, error instanceof Error ? error.message : "response_read_failed"); }
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
      data = parsed as Record<string, unknown>;
    } catch { return emptyResult("request_failed", promptText, "invalid_json"); }

    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
    const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
    const answerText = typeof message.content === "string" ? message.content : "";
    const usageRaw = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {};
    const usage = Object.keys(usageRaw).length ? {
      ...(typeof usageRaw.prompt_tokens === "number" ? { promptTokens: usageRaw.prompt_tokens } : {}),
      ...(typeof usageRaw.completion_tokens === "number" ? { completionTokens: usageRaw.completion_tokens } : {}),
      ...(typeof usageRaw.total_tokens === "number" ? { totalTokens: usageRaw.total_tokens } : {}),
    } : null;
    const costEstimate = typeof usageRaw.cost === "number" && Number.isFinite(usageRaw.cost) ? usageRaw.cost : null;
    return {
      status: answerText.trim() ? "succeeded" : "answer_absent",
      promptText,
      answerText: answerText.trim() ? answerText : null,
      modelVersion: typeof data.model === "string" ? data.model : null,
      requestId: typeof data.id === "string" ? data.id : null,
      citedUrls: citationsFrom(data),
      mentionedBrands: answerText.trim() ? detectedBrands(answerText, input) : null,
      usage,
      costEstimate,
    };
  } finally { clearTimeout(timeout); }
}
