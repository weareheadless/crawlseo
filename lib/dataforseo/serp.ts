import { db } from "@/lib/db";
import { decrypt, decryptCredential } from "@/lib/encryption";

const ENDPOINT = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export type GoogleSerpInput = {
  projectId: string;
  question: string;
  languageCode: string;
  locationCode: number;
  device: "desktop" | "mobile";
};
export type GoogleSerpResponse = { payload: unknown; taskId: string | null; costMicros: number | null };

export class DataForSeoRequestError extends Error {
  constructor(readonly kind: "rate_limited" | "request_failed" | "configuration_error", message: string) {
    super(message);
    this.name = "DataForSeoRequestError";
  }
}

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

/** One bounded live SERP call; deliberately no retries because each call may incur spend. */
export async function fetchGoogleSerp(input: GoogleSerpInput): Promise<GoogleSerpResponse> {
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
        keyword: input.question,
        language_code: input.languageCode,
        location_code: input.locationCode,
        device: input.device,
        os: input.device === "desktop" ? "windows" : "android",
        depth: 10,
        group_organic_results: true,
      }]),
    });
    if (!response.ok) {
      if (response.status === 429) throw new DataForSeoRequestError("rate_limited", "DataForSEO rate limit reached");
      if (response.status === 401 || response.status === 403) throw new DataForSeoRequestError("configuration_error", `DataForSEO rejected credentials (HTTP ${response.status})`);
      throw new DataForSeoRequestError("request_failed", `DataForSEO SERP request failed (HTTP ${response.status})`);
    }
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw new DataForSeoRequestError("request_failed", "DataForSEO SERP response exceeded size limit");
    let root: Record<string, unknown> | null;
    try { root = object(JSON.parse(raw)); } catch { throw new DataForSeoRequestError("request_failed", "DataForSEO returned malformed JSON"); }
    if (!root || Number(root.status_code) !== 20000 || !Array.isArray(root.tasks)) {
      throw new DataForSeoRequestError("request_failed", "DataForSEO returned an invalid SERP payload");
    }
    const task = object(root.tasks[0]);
    if (!task || Number(task.status_code) !== 20000 || !Array.isArray(task.result)) {
      throw new DataForSeoRequestError("request_failed", "DataForSEO returned an invalid SERP task");
    }
    return {
      payload: root,
      taskId: typeof task.id === "string" ? task.id.slice(0, 160) : null,
      costMicros: costMicros(task.cost ?? root.cost),
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
