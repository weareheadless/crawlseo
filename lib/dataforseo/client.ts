import { db } from "@/lib/db";
import { decrypt, decryptCredential } from "@/lib/encryption";
import {
  resolveDataForSeoLocaleFromCatalog,
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
      kind: "KEYWORD_SEED";
      seed: string;
      languageCode: string;
      locationCode: number;
    };

export type DataForSeoOperationResult = {
  kind: DataForSeoOperation["kind"];
  result: DomainOverviewResult | BacklinksOverviewResult | KeywordResult[];
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
    rank: number | null;
    domain: string;
    title: string;
    url: string;
    description: string;
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
  const res = await fetch(`https://api.dataforseo.com/v3${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(login, password),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(`DataForSEO ${endpoint} error: ${res.status} ${res.statusText}`);
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
    const keywordInfo = asObject(keywordData?.keyword_info);
    const monthlySearches = Array.isArray(keywordInfo?.monthly_searches) ? keywordInfo.monthly_searches : null;
    const keyword = keywordData?.keyword ?? item.keyword;
    return [{
      keyword: String(keyword ?? "").slice(0, 200),
      volume: asNumber(keywordInfo?.search_volume),
      difficulty: asNumber(keywordInfo?.keyword_difficulty),
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
      .slice(0, 10)
      .map((item) => ({
        rank: asNumber(item?.rank_group),
        domain: String(item?.domain ?? "").slice(0, 253),
        title: String(item?.title ?? "").slice(0, 500),
        url: String(item?.url ?? "").slice(0, 2_000),
        description: String(item?.description ?? "").slice(0, 1_000),
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
  return resolveDataForSeoLocaleFromCatalog(
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
export async function executeDataForSeoOrganicSerp(input: {
  projectId: string;
  keyword: string;
  languageCode: string;
  locationCode: number;
}): Promise<DataForSeoSerpResearchResult> {
  const credentials = await credentialsForProject(input.projectId);
  const response = await dataforseoPostWithMeta(
    credentials.login,
    credentials.password,
    "/serp/google/organic/live/advanced",
    [{
      keyword: input.keyword,
      language_code: input.languageCode,
      location_code: input.locationCode,
      device: "desktop",
      os: "windows",
      depth: 10,
      group_organic_results: true,
    }]
  );
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

  const credentials = await credentialsForProject(input.projectId);

  const operation = input.operation;
  let endpoint: string;
  let body: Record<string, unknown>;
  let normalize: (data: unknown) => DomainOverviewResult | BacklinksOverviewResult | KeywordResult[] | null;

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
