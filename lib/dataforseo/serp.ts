import { db } from "@/lib/db";
import { decrypt, decryptCredential } from "@/lib/encryption";

const ENDPOINT = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export type GoogleSerpInput = {
  projectId: string;
  question: string;
  languageCode: string;
  locationCode: number;
  device: "desktop" | "mobile";
};
export type GoogleSerpResponse = {
  payload: unknown;
  taskId: string | null;
  costMicros: number | null;
  /** The phrase actually sent; differs from the question when it needed cleaning. */
  searchedKeyword: string;
};

/**
 * The provider's search engine returns 40101 on some punctuated queries - a
 * question mark or a comma is enough - while the same words without punctuation
 * answer normally. The question is still the identity of the observation; the
 * cleaned phrase is what was searched.
 */
export function normalizeSerpKeyword(value: string): string {
  const cleaned = value
    .replace(/[?!,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || value.trim().slice(0, 120);
}

export class DataForSeoRequestError extends Error {
  constructor(
    readonly kind: "rate_limited" | "request_failed" | "configuration_error",
    message: string,
    /** DataForSEO's own task status code, when the failure came from the task. */
    readonly providerCode: number | null = null
  ) {
    super(message);
    this.name = "DataForSeoRequestError";
  }
}

/**
 * Provider-side search engine failures. They are transient and the task is not
 * billed, so the same request is worth sending again; a rejected payload (40501)
 * or a credentials problem is not.
 */
const RETRYABLE_TASK_CODES = new Set([40101, 40102, 50000]);

async function projectCredentials(projectId: string) {
  const grant = await db.projectApiKeyGrant.findFirst({
    where: { projectId, provider: "dataforseo", status: "ACTIVE" },
    select: {
      apiKey: { select: { encryptedLogin: true, encryptedPassword: true } },
      providerCredential: { select: { status: true, encryptedLogin: true, encryptedPassword: true } },
    },
  });
  if (!grant) throw new DataForSeoRequestError("configuration_error", "DataForSEO is not configured for this project (active grant missing)");
  if (grant.providerCredential && grant.providerCredential.status !== "ACTIVE") {
    throw new DataForSeoRequestError("configuration_error", "DataForSEO platform credentials are inactive");
  }
  const credentials = grant.providerCredential
    ? { login: decryptCredential(grant.providerCredential.encryptedLogin), password: decryptCredential(grant.providerCredential.encryptedPassword) }
    : grant.apiKey
      ? { login: decrypt(grant.apiKey.encryptedLogin), password: decrypt(grant.apiKey.encryptedPassword) }
      : null;
  if (!credentials) throw new DataForSeoRequestError("configuration_error", "DataForSEO credentials are not configured for this project");
  return credentials;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function costMicros(value: unknown): number | null {
  const amount = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 1_000_000) : null;
}
async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DataForSeoRequestError("request_failed", "DataForSEO SERP response exceeded size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function requestGoogleSerp(input: GoogleSerpInput): Promise<GoogleSerpResponse> {
  const credentials = await projectCredentials(input.projectId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{
        keyword: normalizeSerpKeyword(input.question),
        language_code: input.languageCode,
        location_code: input.locationCode,
        device: input.device,
        os: input.device === "desktop" ? "windows" : "android",
        depth: 10,
        group_organic_results: true,
        // AI Overview content is generated asynchronously; without this the item is a placeholder.
        load_async_ai_overview: true,
      }]),
    });
    if (!response.ok) {
      if (response.status === 429) throw new DataForSeoRequestError("rate_limited", "DataForSEO rate limit reached");
      if (response.status === 401 || response.status === 403) throw new DataForSeoRequestError("configuration_error", `DataForSEO rejected credentials (HTTP ${response.status})`);
      throw new DataForSeoRequestError("request_failed", `DataForSEO SERP request failed (HTTP ${response.status})`);
    }
    const raw = await readBoundedBody(response);
    let root: Record<string, unknown> | null;
    try { root = object(JSON.parse(raw)); } catch { throw new DataForSeoRequestError("request_failed", "DataForSEO returned malformed JSON"); }
    if (!root || Number(root.status_code) !== 20000 || !Array.isArray(root.tasks)) {
      throw new DataForSeoRequestError("request_failed", "DataForSEO returned an invalid SERP payload");
    }
    const task = object(root.tasks[0]);
    if (!task || Number(task.status_code) !== 20000 || !Array.isArray(task.result)) {
      // The task status carries the provider's own reason; without it the only
      // thing a caller can say is "invalid task", which is not diagnosable.
      const code = task ? Number(task.status_code) : null;
      const message = task && typeof task.status_message === "string" ? task.status_message.slice(0, 200) : null;
      throw new DataForSeoRequestError(
        "request_failed",
        `DataForSEO rejected the SERP task${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`,
        code
      );
    }
    return {
      payload: root,
      taskId: typeof task.id === "string" ? task.id.slice(0, 160) : null,
      costMicros: costMicros(task.cost ?? root.cost),
      searchedKeyword: normalizeSerpKeyword(input.question),
    };
  } catch (error) {
    if (error instanceof DataForSeoRequestError) throw error;
    if (error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message))) {
      throw new DataForSeoRequestError("request_failed", "DataForSEO SERP request timed out");
    }
    throw new DataForSeoRequestError("request_failed", "DataForSEO SERP request failed");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One bounded live SERP call.
 *
 * A provider-side search engine error (40101) is retried once: it is transient,
 * the failed task is not billed, and without the retry a random third of the AEO
 * questions silently disappears from the bundle. Every other failure is final,
 * so a bad payload or bad credentials never spends twice.
 */
export async function fetchGoogleSerp(input: GoogleSerpInput): Promise<GoogleSerpResponse> {
  try {
    return await requestGoogleSerp(input);
  } catch (error) {
    const retryable = error instanceof DataForSeoRequestError
      && error.kind === "request_failed"
      && error.providerCode !== null
      && RETRYABLE_TASK_CODES.has(error.providerCode);
    if (!retryable) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return requestGoogleSerp(input);
  }
}
