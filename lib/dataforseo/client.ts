import { db } from "@/lib/db";
import { decrypt, decryptCredential } from "@/lib/encryption";
import {
  resolveDataForSeoLocaleFromCatalog,
  resolveDataForSeoLocaleWithFallback,
  type DataForSeoLocaleCatalogEntry,
  type ResolvedDataForSeoLocale,
} from "@/lib/dataforseo/locale";

const DATAFORSEO_LOCALE_CATALOG_ENDPOINT = "/dataforseo_labs/locations_and_languages";
const DATAFORSEO_LOCALE_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

const localeCatalogCache = new Map<string, {
  expiresAt: number;
  entries: DataForSeoLocaleCatalogEntry[];
}>();
const localeCatalogInFlight = new Map<string, Promise<DataForSeoLocaleCatalogEntry[]>>();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeywordResult = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  trend: number[] | null; // monthly search volume trend
};

export type DomainOverviewResult = {
  organicKeywords: number;
  organicTraffic: number;
  organicCost: number;
  backlinks: number;
  referringDomains: number;
};

export type BacklinksOverviewResult = {
  totalBacklinks: number;
  referringDomains: number;
  referringIps: number;
  dofollow: number;
  nofollow: number;
};

/**
 * CMP-007: the domains that link to a target, with their own provider metrics.
 *
 * This is the shape the link-target list is built from: a domain, its rank, its
 * backlink count and the page it links to. Nothing here is a judgement about the
 * domain — the numbers are what the provider reports, and ordering by them is the
 * caller's declared choice.
 */
export type ReferringDomainRow = {
  domain: string;
  /** Provider rank of the linking domain (higher = stronger). */
  rank: number | null;
  backlinks: number | null;
  /** The competitor URL this domain links to, when the provider says. */
  targetUrl: string | null;
  /** `dofollow` or `nofollow` for the link to the target. */
  linkType: string | null;
};

export type ReferringDomainsResult = {
  target: string;
  domains: ReferringDomainRow[];
};

export type DataForSeoOperation =
  | {
      kind: "DOMAIN_OVERVIEW";
      domain: string;
      languageCode: string;
      locationCode: number;
    }
  | {
      kind: "BACKLINKS_OVERVIEW";
      domain: string;
    }
  | {
      /** CMP-007: the domains linking to a competitor, for the link-target gap. */
      kind: "REFERRING_DOMAINS";
      domain: string;
      limit?: number;
    }
  | {
      kind: "KEYWORD_SEED";
      seed: string;
      languageCode: string;
      locationCode: number;
    };

/** How many referring domains one call asks for. Declared, so the cost is knowable. */
export const REFERRING_DOMAINS_LIMIT = 200;

export type DataForSeoOperationResult = {
  kind: DataForSeoOperation["kind"];
  result: DomainOverviewResult | BacklinksOverviewResult | ReferringDomainsResult | KeywordResult[];
  providerTaskId: string | null;
  costMicros: number | null;
};

export type DataForSeoKeywordResearchResult = {
  result: KeywordResult[];
  providerTaskId: string | null;
  costMicros: number | null;
};

export type KeywordOverviewMetric = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  competitionLevel: string | null;
  intent: string | null;
  trend: number[] | null;
};

export type OrganicSerpResult = {
  query: string;
  checkedAt: string | null;
  itemTypes: string[];
  organic: Array<{
    /** `rank_group`: the position among organic results only. */
    rank: number | null;
    /**
     * `rank_absolute`: the position on the whole page, including blocks that sit
     * above the organic list. Our position is reported from this field: a result
     * at organic 1 behind a feature block is not page position 1, and the CTR
     * curve the scoring uses is per page position.
     */
    rankAbsolute: number | null;
    domain: string;
    title: string;
    url: string;
    description: string;
    /**
     * The provider's real-identity fields for this result. On live output the
     * `url` is frequently an opaque `google.com/goto` wrapper; the breadcrumb then
     * holds the actual host and path, so attribution reads these rather than
     * trusting `url`.
     */
    breadcrumb: string | null;
    websiteName: string | null;
  }>;
  peopleAlsoAsk: Array<{ question: string; url: string }>;
  relatedSearches: string[];
  localPack: Array<{ title: string; url: string; rating: number | null }>;
};

export type DataForSeoCandidateMetricsResult = {
  result: KeywordOverviewMetric[];
  providerTaskId: string | null;
  costMicros: number | null;
};

export type DataForSeoSerpResearchResult = {
  result: OrganicSerpResult;
  providerTaskId: string | null;
  costMicros: number | null;
};

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function authHeader(login: string, password: string): string {
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

/** Validate credentials against the provider's non-billable account endpoint. */
export async function testConnection(login: string, password: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.dataforseo.com/v3/appendix/user_data", {
      method: "GET",
      headers: { Authorization: authHeader(login, password) },
    });
    if (!response.ok) return false;
    const json = await response.json();
    return json.status_code === 20000;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Base request
// ---------------------------------------------------------------------------

function costMicros(value: unknown): number | null {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 1_000_000);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function dataforseoPostWithMeta(
  login: string,
  password: string,
  endpoint: string,
  body: unknown[]
): Promise<{ data: unknown; providerTaskId: string | null; costMicros: number | null }> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    res = await fetch(`https://api.dataforseo.com/v3${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: authHeader(login, password),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    // DataForSEO rate-limits per minute; a burst across queries is normal.
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
        continue;
      }
    }
    break;
  }

  if (!res || !res.ok) {
    console.error(`DataForSEO ${endpoint} error: ${res?.status ?? "no response"} ${res?.statusText ?? ""}`);
    return { data: null, providerTaskId: null, costMicros: null };
  }

  const json = await res.json() as Record<string, unknown>;
  if (json.status_code !== 20000) {
    console.error(`DataForSEO ${endpoint} API error:`, json.status_message);
    return { data: null, providerTaskId: null, costMicros: null };
  }

  const task = Array.isArray(json.tasks) ? asObject(json.tasks[0]) : null;
  if (!task) throw new Error("DATAFORSEO_TASK_MISSING");
  const taskStatusCode = Number(task.status_code);
  if (!Number.isFinite(taskStatusCode) || taskStatusCode !== 20000) {
    const message = typeof task.status_message === "string" ? task.status_message.slice(0, 180) : "unknown task error";
    throw new Error(`DATAFORSEO_TASK_${taskStatusCode || "INVALID"}: ${message}`);
  }
  return {
    data: json,
    providerTaskId: typeof task?.id === "string" ? task.id : null,
    costMicros: costMicros(task?.cost ?? json.cost),
  };
}

async function dataforseoGetJson(
  login: string,
  password: string,
  endpoint: string
): Promise<unknown> {
  const response = await fetch(`https://api.dataforseo.com/v3${endpoint}`, {
    method: "GET",
    headers: { Authorization: authHeader(login, password) },
  });
  if (!response.ok) {
    throw new Error(`DATAFORSEO_LOCALE_CATALOG_HTTP_${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("DATAFORSEO_LOCALE_CATALOG_INVALID_JSON");
  }
}

function normalizeKeywordResults(data: unknown): KeywordResult[] {
  const root = asObject(data);
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = asObject(tasks[0]);
  const results = task && Array.isArray(task.result) ? task.result : [];
  const firstResult = asObject(results[0]);
  const items = firstResult && Array.isArray(firstResult.items) ? firstResult.items : [];
  return items.slice(0, 50).flatMap((rawItem) => {
    const item = asObject(rawItem);
    if (!item) return [];
    const keywordData = asObject(item.keyword_data);
    // related_keywords nests under keyword_data; keyword_suggestions returns the
    // info at the item level. Both shapes reach this normalizer.
    const keywordInfo = asObject(keywordData?.keyword_info) ?? asObject(item.keyword_info);
    const properties = asObject(keywordData?.keyword_properties) ?? asObject(item.keyword_properties);
    const monthlySearches = Array.isArray(keywordInfo?.monthly_searches) ? keywordInfo.monthly_searches : null;
    const keyword = keywordData?.keyword ?? item.keyword;
    return [{
      keyword: String(keyword ?? "").slice(0, 200),
      volume: asNumber(keywordInfo?.search_volume),
      difficulty: asNumber(keywordInfo?.keyword_difficulty) ?? asNumber(properties?.keyword_difficulty),
      cpc: asNumber(keywordInfo?.cpc),
      competition: asNumber(keywordInfo?.competition),
      trend: monthlySearches
        ? monthlySearches.slice(0, 24).map((month) => asNumber(asObject(month)?.search_volume) ?? 0)
        : null,
    }];
  });
}

function normalizeKeywordOverview(data: unknown): KeywordOverviewMetric[] {
  const root = asObject(data);
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = asObject(tasks[0]);
  const results = task && Array.isArray(task.result) ? task.result : [];
  const firstResult = asObject(results[0]);
  const items = firstResult && Array.isArray(firstResult.items) ? firstResult.items : [];
  return items.slice(0, 10).flatMap((rawItem) => {
    const item = asObject(rawItem);
    if (!item) return [];
    const keywordInfo = asObject(item.keyword_info);
    const properties = asObject(item.keyword_properties);
    const intent = asObject(item.search_intent_info);
    const monthlySearches = Array.isArray(keywordInfo?.monthly_searches)
      ? keywordInfo.monthly_searches
      : null;
    return [{
      keyword: String(item.keyword ?? "").slice(0, 120),
      volume: asNumber(keywordInfo?.search_volume),
      difficulty: asNumber(properties?.keyword_difficulty),
      cpc: asNumber(keywordInfo?.cpc),
      competition: asNumber(keywordInfo?.competition),
      competitionLevel: typeof keywordInfo?.competition_level === "string"
        ? keywordInfo.competition_level.slice(0, 20)
        : null,
      intent: typeof intent?.main_intent === "string" ? intent.main_intent.slice(0, 30) : null,
      trend: monthlySearches
        ? monthlySearches.slice(0, 24).map((month) => asNumber(asObject(month)?.search_volume) ?? 0)
        : null,
    }];
  });
}

function normalizeOrganicSerp(data: unknown): OrganicSerpResult | null {
  const root = asObject(data);
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = asObject(tasks[0]);
  const results = task && Array.isArray(task.result) ? task.result : [];
  const result = asObject(results[0]);
  if (!result) return null;
  const items = Array.isArray(result.items) ? result.items.map(asObject).filter(Boolean) : [];
  const nestedItems = (type: string) => items
    .filter((item) => item?.type === type)
    .flatMap((item) => Array.isArray(item?.items) ? item.items.map(asObject).filter(Boolean) : []);

  return {
    query: String(result.keyword ?? "").slice(0, 120),
    checkedAt: typeof result.datetime === "string" ? result.datetime.slice(0, 80) : null,
    itemTypes: Array.isArray(result.item_types)
      ? result.item_types.slice(0, 30).map((value) => String(value).slice(0, 50))
      : [],
    organic: items
      .filter((item) => item?.type === "organic")
      .map((item) => ({
        rank: asNumber(item?.rank_group),
        rankAbsolute: asNumber(item?.rank_absolute),
        domain: String(item?.domain ?? "").slice(0, 253),
        title: String(item?.title ?? "").slice(0, 500),
        url: String(item?.url ?? "").slice(0, 2_000),
        description: String(item?.description ?? "").slice(0, 1_000),
        breadcrumb: typeof item?.breadcrumb === "string" ? item.breadcrumb.slice(0, 2_000) : null,
        websiteName: typeof item?.website_name === "string" ? item.website_name.slice(0, 253) : null,
      })),
    peopleAlsoAsk: nestedItems("people_also_ask").slice(0, 8).map((item) => ({
      question: String(item?.title ?? "").slice(0, 500),
      url: String(item?.url ?? "").slice(0, 2_000),
    })),
    relatedSearches: nestedItems("related_searches")
      .slice(0, 10)
      .map((item) => String(item?.title ?? "").slice(0, 300)),
    localPack: nestedItems("local_pack").slice(0, 5).map((item) => ({
      title: String(item?.title ?? "").slice(0, 500),
      url: String(item?.url ?? "").slice(0, 2_000),
      rating: asNumber(item?.rating),
    })),
  };
}

export function parseDataForSeoLocaleCatalog(data: unknown): DataForSeoLocaleCatalogEntry[] {
  const root = asObject(data);
  const rootStatus = Number(root?.status_code);
  if (rootStatus !== 20000) {
    throw new Error(`DATAFORSEO_LOCALE_CATALOG_${rootStatus || "INVALID"}`);
  }
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = asObject(tasks[0]);
  const taskStatus = Number(task?.status_code);
  if (taskStatus !== 20000) {
    throw new Error(`DATAFORSEO_LOCALE_CATALOG_TASK_${taskStatus || "INVALID"}`);
  }
  const locations = task && Array.isArray(task.result) ? task.result : [];
  const entries = new Map<string, DataForSeoLocaleCatalogEntry>();
  for (const rawLocation of locations) {
    const location = asObject(rawLocation);
    if (!location) continue;
    const locationType = String(location.location_type || "").trim().toLowerCase();
    if (locationType && locationType !== "country") continue;
    const country = String(location.country_iso_code || "").trim().toUpperCase();
    const locationCode = asNumber(location.location_code);
    if (!/^[A-Z]{2}$/.test(country) || locationCode === null || !Number.isInteger(locationCode) || locationCode < 1) {
      continue;
    }
    const languages = Array.isArray(location.available_languages)
      ? location.available_languages
      : [];
    for (const rawLanguage of languages) {
      const language = asObject(rawLanguage);
      if (!language) continue;
      const sources = Array.isArray(language.available_sources) ? language.available_sources : [];
      if (!sources.some((source) => String(source).trim().toLowerCase() === "google")) continue;
      const languageCode = String(language.language_code || "").trim().toLowerCase();
      if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(languageCode)) continue;
      const key = `${country}:${languageCode.split("-", 1)[0]}`;
      if (!entries.has(key)) entries.set(key, { country, languageCode, locationCode });
    }
  }
  if (!entries.size) throw new Error("DATAFORSEO_LOCALE_CATALOG_EMPTY");
  return [...entries.values()];
}

type DataForSeoCredentials = {
  grantId: string;
  login: string;
  password: string;
};

async function credentialsForProject(projectId: string): Promise<DataForSeoCredentials> {
  const grant = await db.projectApiKeyGrant.findFirst({
    where: {
      projectId,
      provider: "dataforseo",
      status: "ACTIVE",
    },
    select: {
      id: true,
      apiKey: { select: { encryptedLogin: true, encryptedPassword: true } },
      providerCredential: {
        select: { status: true, encryptedLogin: true, encryptedPassword: true },
      },
    },
  });
  if (!grant) throw new Error("DATAFORSEO_GRANT_MISSING");
  if (grant.providerCredential && grant.providerCredential.status !== "ACTIVE") {
    throw new Error("DATAFORSEO_CREDENTIAL_INACTIVE");
  }
  const creds = grant.providerCredential
    ? {
        login: decryptCredential(grant.providerCredential.encryptedLogin),
        password: decryptCredential(grant.providerCredential.encryptedPassword),
      }
    : grant.apiKey
      ? {
          login: decrypt(grant.apiKey.encryptedLogin),
          password: decrypt(grant.apiKey.encryptedPassword),
        }
      : null;
  if (!creds) throw new Error("DataForSEO credentials are not configured");
  return { grantId: grant.id, ...creds };
}

async function markDataForSeoGrantValidated(grantId: string): Promise<void> {
  await db.projectApiKeyGrant.update({
    where: { id: grantId },
    data: { lastValidatedAt: new Date() },
  });
}

async function loadDataForSeoLocaleCatalog(
  grantId: string,
  login: string,
  password: string
): Promise<DataForSeoLocaleCatalogEntry[]> {
  const cached = localeCatalogCache.get(grantId);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;

  const existing = localeCatalogInFlight.get(grantId);
  if (existing) return existing;

  const request = (async () => {
    const data = await dataforseoGetJson(login, password, DATAFORSEO_LOCALE_CATALOG_ENDPOINT);
    const entries = parseDataForSeoLocaleCatalog(data);
    localeCatalogCache.set(grantId, {
      entries,
      expiresAt: Date.now() + DATAFORSEO_LOCALE_CATALOG_TTL_MS,
    });
    await markDataForSeoGrantValidated(grantId);
    return entries;
  })();
  localeCatalogInFlight.set(grantId, request);
  try {
    return await request;
  } finally {
    if (localeCatalogInFlight.get(grantId) === request) localeCatalogInFlight.delete(grantId);
  }
}

export async function getDataForSeoLocaleCatalog(projectId: string): Promise<DataForSeoLocaleCatalogEntry[]> {
  const credentials = await credentialsForProject(projectId);
  return loadDataForSeoLocaleCatalog(credentials.grantId, credentials.login, credentials.password);
}

export async function resolveDataForSeoLocale(
  projectId: string,
  language: unknown,
  country: unknown
): Promise<ResolvedDataForSeoLocale> {
  // Exact pair first; when DataForSEO does not offer it, one axis is sacrificed
  // and recorded instead of failing the caller.
  return resolveDataForSeoLocaleWithFallback(
    await getDataForSeoLocaleCatalog(projectId),
    language,
    country
  );
}

/** Execute one related-keywords task for an audience-led article idea. */
export async function executeDataForSeoRelatedKeywords(input: {
  projectId: string;
  seed: string;
  languageCode: string;
  locationCode: number;
}): Promise<DataForSeoKeywordResearchResult> {
  const credentials = await credentialsForProject(input.projectId);
  const response = await dataforseoPostWithMeta(
    credentials.login,
    credentials.password,
    "/dataforseo_labs/google/related_keywords/live",
    [{
      keyword: input.seed,
      language_code: input.languageCode,
      location_code: input.locationCode,
      depth: 1,
      limit: 50,
    }]
  );
  if (!response.data) throw new Error("DataForSEO operation failed");
  const result = normalizeKeywordResults(response.data);
  await markDataForSeoGrantValidated(credentials.grantId);
  return {
    result,
    providerTaskId: response.providerTaskId,
    costMicros: response.costMicros,
  };
}

/** Measure Ada's bounded candidate list without asking the provider to generate topics. */
/**
 * Labs `keyword_suggestions`: the keywords people actually type around a phrase.
 * Used to derive a measurable keyword when a research phrase has no volume data.
 */
export async function executeDataForSeoKeywordSuggestions(input: {
  projectId: string;
  keyword: string;
  languageCode: string;
  locationCode: number;
  limit?: number;
}): Promise<DataForSeoKeywordResearchResult> {
  const credentials = await credentialsForProject(input.projectId);
  const response = await dataforseoPostWithMeta(
    credentials.login,
    credentials.password,
    "/dataforseo_labs/google/keyword_suggestions/live",
    [{
      keyword: input.keyword,
      language_code: input.languageCode,
      location_code: input.locationCode,
      limit: Math.max(1, Math.min(input.limit ?? 20, 100)),
    }]
  );
  if (!response.data) throw new Error("DataForSEO operation failed");
  const result = normalizeKeywordResults(response.data);
  await markDataForSeoGrantValidated(credentials.grantId);
  return { result, providerTaskId: response.providerTaskId, costMicros: response.costMicros };
}

export async function executeDataForSeoKeywordOverview(input: {
  projectId: string;
  keywords: string[];
  languageCode: string;
  locationCode: number;
}): Promise<DataForSeoCandidateMetricsResult> {
  const credentials = await credentialsForProject(input.projectId);
  const response = await dataforseoPostWithMeta(
    credentials.login,
    credentials.password,
    "/dataforseo_labs/google/keyword_overview/live",
    [{
      keywords: input.keywords,
      language_code: input.languageCode,
      location_code: input.locationCode,
      include_serp_info: false,
      include_clickstream_data: false,
    }]
  );
  if (!response.data) throw new Error("DataForSEO operation failed");
  const result = normalizeKeywordOverview(response.data);
  await markDataForSeoGrantValidated(credentials.grantId);
  return {
    result,
    providerTaskId: response.providerTaskId,
    costMicros: response.costMicros,
  };
}

/** Capture one bounded SERP after Ada has selected or reframed a candidate. */
export type SerpCompetitor = {
  domain: string;
  keywordsCount: number | null;
  avgPosition: number | null;
  etv: number | null;
};

export type DataForSeoLabsCompetitorsResult = {
  result: SerpCompetitor[];
  providerTaskId: string | null;
  costMicros: number | null;
};

/**
 * Labs `serp_competitors`: which domains rank for these queries and how many of
 * them they cover. This is the competitor side of the "research asks DataForSEO"
 * link — positioning gaps need to know who is actually present.
 */
export async function executeDataForSeoLabsSerpCompetitors(input: {
  projectId: string;
  keywords: string[];
  languageCode: string;
  locationCode: number;
  limit?: number;
}): Promise<DataForSeoLabsCompetitorsResult> {
  const credentials = await credentialsForProject(input.projectId);
  const response = await dataforseoPostWithMeta(
    credentials.login,
    credentials.password,
    "/dataforseo_labs/google/serp_competitors/live",
    [{
      keywords: input.keywords.slice(0, 20),
      language_code: input.languageCode,
      location_code: input.locationCode,
      item_types: ["organic"],
      limit: Math.max(1, Math.min(input.limit ?? 20, 100)),
    }]
  );
  if (!response.data) throw new Error("DataForSEO operation failed");
  const root = asObject(response.data);
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = asObject(tasks[0]);
  const results = task && Array.isArray(task.result) ? task.result : [];
  const first = asObject(results[0]);
  const items = first && Array.isArray(first.items) ? first.items : [];
  const result: SerpCompetitor[] = items.slice(0, 100).flatMap((rawItem) => {
    const item = asObject(rawItem);
    if (!item || typeof item.domain !== "string") return [];
    return [{
      domain: item.domain,
      keywordsCount: asNumber(item.keywords_count),
      avgPosition: asNumber(item.avg_position),
      etv: asNumber(item.etv),
    }];
  });
  return {
    result,
    providerTaskId: typeof task?.id === "string" ? task.id : null,
    costMicros: costMicros(task?.cost ?? root?.cost),
  };
}

/**
 * Provider-side search engine failures are transient and the failed task is not
 * billed. The same request is worth sending again; a rejected payload is not.
 */
const RETRYABLE_SERP_TASK_CODES = new Set(["40101", "40102", "50000"]);

function isRetryableSerpTaskError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const match = /^DATAFORSEO_TASK_(\d+)\b/.exec(error.message);
  return Boolean(match && RETRYABLE_SERP_TASK_CODES.has(match[1]));
}

/**
 * Bound the requested SERP depth.
 *
 * The funnel scores positions 1–10 and targets the top ten, so ten is the floor
 * that still answers "who ranks where". Twenty keeps a margin for feature blocks
 * that push organic results down the page. Higher depths are allowed but cost
 * more per call: DataForSEO bills live SERP by depth, and the recorded
 * `serpPerQueryMicros` estimate was measured at depth 10.
 */
function normalizeSerpDepth(depth: number | undefined): number {
  if (depth == null || !Number.isFinite(depth)) return 20;
  return Math.max(10, Math.min(100, Math.trunc(depth)));
}

export async function executeDataForSeoOrganicSerp(input: {
  projectId: string;
  keyword: string;
  languageCode: string;
  locationCode: number;
  /** SERP device. Rankings are device-specific, so it is explicit, not implied. */
  device?: "desktop" | "mobile";
  /**
   * How many results to ask for. Defaults to 20, which covers the scoring window
   * plus the feature blocks above it. Raising it is a deliberate caller decision
   * with a per-call cost.
   */
  depth?: number;
}): Promise<DataForSeoSerpResearchResult> {
  const credentials = await credentialsForProject(input.projectId);
  const body = [{
    keyword: input.keyword,
    language_code: input.languageCode,
    location_code: input.locationCode,
    device: input.device ?? "desktop",
    os: input.device === "mobile" ? "android" : "windows",
    depth: normalizeSerpDepth(input.depth),
    // Grouped results collapse the organic list into blocks, and are what
    // returned local/redirect sets instead of ranked pages. Positions must come
    // from the ungrouped list or "who ranks third" is unanswerable.
  }];
  let response;
  try {
    response = await dataforseoPostWithMeta(credentials.login, credentials.password, "/serp/google/organic/live/advanced", body);
  } catch (error) {
    if (!isRetryableSerpTaskError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await dataforseoPostWithMeta(credentials.login, credentials.password, "/serp/google/organic/live/advanced", body);
  }
  if (!response.data) throw new Error("DataForSEO operation failed");
  const result = normalizeOrganicSerp(response.data);
  if (!result) throw new Error("DataForSEO SERP operation returned no result");
  await markDataForSeoGrantValidated(credentials.grantId);
  return {
    result,
    providerTaskId: response.providerTaskId,
    costMicros: response.costMicros,
  };
}

function normalizeDomainOverview(data: unknown): DomainOverviewResult | null {
  const root = asObject(data);
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = asObject(tasks[0]);
  const results = task && Array.isArray(task.result) ? task.result : [];
  const item = asObject(results[0]);
  if (!item) return null;
  const metrics = asObject(item.metrics);
  const organic = asObject(metrics?.organic) ?? {};
  return {
    organicKeywords: asNumber(organic.count) ?? 0,
    organicTraffic: asNumber(organic.etv) ?? 0,
    organicCost: asNumber(organic.estimated_paid_traffic_cost) ?? 0,
    backlinks: asNumber(organic.backlinks) ?? 0,
    referringDomains: asNumber(organic.referring_domains) ?? 0,
  };
}

/**
 * CMP-007: read the referring-domains response into the link-target shape.
 *
 * The provider returns one item per linking domain (or per link, depending on the
 * mode); both are folded to one row per domain at its strongest link, because a
 * domain that links from five pages is one outreach target, not five.
 */
function normalizeReferringDomains(data: unknown, target: string): ReferringDomainsResult | null {
  const root = asObject(data);
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = asObject(tasks[0]);
  const results = task && Array.isArray(task.result) ? task.result : [];
  const first = asObject(results[0]);
  const items = first && Array.isArray(first.items) ? (first.items as unknown[]) : [];

  const byDomain = new Map<string, ReferringDomainRow>();
  for (const raw of items) {
    const item = asObject(raw);
    if (!item) continue;
    const domain =
      typeof item.domain_from === "string" ? item.domain_from : typeof item.domain === "string" ? item.domain : "";
    if (!domain) continue;
    const rank = asNumber(item.rank);
    const backlinks = asNumber(item.backlinks);
    const targetUrl = typeof item.url_to === "string" ? item.url_to : null;
    const linkType = typeof item.link_type === "string" ? item.link_type : null;
    const existing = byDomain.get(domain);
    if (existing) {
      // Keep the strongest link from one domain: the highest rank, then the most
      // backlinks. Ordering is by a declared number, not a judgement.
      if ((rank ?? 0) > (existing.rank ?? 0)) existing.rank = rank;
      if ((backlinks ?? 0) > (existing.backlinks ?? 0)) existing.backlinks = backlinks;
      if (!existing.targetUrl && targetUrl) existing.targetUrl = targetUrl;
      continue;
    }
    byDomain.set(domain, { domain, rank, backlinks, targetUrl, linkType });
  }

  if (byDomain.size === 0) return null;
  return { target, domains: [...byDomain.values()] };
}

function normalizeBacklinksOverview(data: unknown): BacklinksOverviewResult | null {
  const root = asObject(data);
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = asObject(tasks[0]);
  const results = task && Array.isArray(task.result) ? task.result : [];
  const item = asObject(results[0]);
  if (!item) return null;
  const backlinks = asNumber(item.backlinks) ?? 0;
  const nofollow = asNumber(item.referring_links_nofollow) ?? 0;
  return {
    totalBacklinks: backlinks,
    referringDomains: asNumber(item.referring_domains) ?? 0,
    referringIps: asNumber(item.referring_ips) ?? 0,
    dofollow: backlinks - nofollow,
    nofollow,
  };
}

/** Execute exactly one task that the research worker has already claimed. */
/**
 * Run one provider operation for a project.
 *
 * Split out from `executeDataForSeoOperation` so a run that keeps its own task
 * bookkeeping (the prelaunch family, which no longer has task rows) can use the
 * same request path. The task-row guard stays with the caller that has task rows.
 */
export async function performDataForSeoOperation(
  projectId: string,
  operation: DataForSeoOperation
): Promise<DataForSeoOperationResult> {
  const credentials = await credentialsForProject(projectId);
  let endpoint: string;
  let body: Record<string, unknown>;
  let normalize: (data: unknown) => DomainOverviewResult | BacklinksOverviewResult | ReferringDomainsResult | KeywordResult[] | null;

  switch (operation.kind) {
    case "DOMAIN_OVERVIEW":
      endpoint = "/dataforseo_labs/google/domain_rank_overview/live";
      body = {
        target: operation.domain,
        language_code: operation.languageCode,
        location_code: operation.locationCode,
      };
      normalize = normalizeDomainOverview;
      break;
    case "BACKLINKS_OVERVIEW":
      endpoint = "/backlinks/summary/live";
      body = { target: operation.domain, internal_list_limit: 0, backlinks_filters: [] };
      normalize = normalizeBacklinksOverview;
      break;
    case "REFERRING_DOMAINS": {
      endpoint = "/backlinks/referring_domains/live";
      // The limit is a declared constant: an unbounded referring-domains call is
      // both slow and expensive, and the link-target list only needs the strongest
      // domains, which the provider returns ranked.
      const limit = Math.max(1, Math.min(operation.limit ?? REFERRING_DOMAINS_LIMIT, 1000));
      body = {
        target: operation.domain,
        limit,
        order_by: ["rank,desc"],
        internal_list_limit: 0,
        backlinks_status_type: "live",
      };
      normalize = (data: unknown) => normalizeReferringDomains(data, operation.domain);
      break;
    }
    case "KEYWORD_SEED":
      endpoint = "/dataforseo_labs/google/related_keywords/live";
      body = {
        keyword: operation.seed,
        language_code: operation.languageCode,
        location_code: operation.locationCode,
        depth: 1,
        limit: 50,
      };
      normalize = normalizeKeywordResults;
      break;
  }

  const response = await dataforseoPostWithMeta(credentials.login, credentials.password, endpoint, [body]);
  if (!response.data) throw new Error("DataForSEO operation failed");
  const result = normalize(response.data);
  if (result === null) throw new Error("DataForSEO operation returned no result");
  if (JSON.stringify(result).length > 200_000) throw new Error("DataForSEO normalized result exceeded the size limit");
  await markDataForSeoGrantValidated(credentials.grantId);
  return {
    kind: operation.kind,
    result,
    providerTaskId: response.providerTaskId,
    costMicros: response.costMicros,
  };
}

export async function executeDataForSeoOperation(
  input: {
    projectId: string;
    researchRunId: string;
    taskId: string;
    operation: DataForSeoOperation;
  }
): Promise<DataForSeoOperationResult> {
  const task = await db.seoResearchTask.findFirst({
    where: {
      id: input.taskId,
      researchRunId: input.researchRunId,
      status: "ATTEMPTING",
      researchRun: { projectId: input.projectId },
    },
    select: { id: true },
  });
  if (!task) throw new Error("DATAFORSEO_TASK_NOT_RESERVED");
  return performDataForSeoOperation(input.projectId, input.operation);
}
