export type ResearchEvidenceSource = {
  id: string;
  provider: string;
  url: string;
  title: string | null;
  author: string | null;
  community: string | null;
  publishedAt: Date | string | null;
  retrievedAt?: Date | string | null;
  excerpt: string | null;
  metadata?: unknown;
};

/** Canonical provider URL identity used for project-scoped observation reuse. */
export function normalizeResearchSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ["gclid", "fbclid", "ref"].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch { return null; }
}

export function researchSourceId(source: { url: string; metadata?: unknown }): string {
  const meta = record(source.metadata);
  const id = meta.reddit_id ?? meta.source_id ?? meta.guid;
  return typeof id === "string" && id.trim() ? id.trim() : normalizeResearchSourceUrl(source.url) ?? source.url;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function jsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

/**
 * Resolve the sources that justify an action. The finding stores the exact
 * source set selected by the synthesizer; evidence.source_ids is the fallback
 * used by actions created without a finding.
 */
export function sourceIdsForAction(action: {
  evidence?: unknown;
  finding?: { evidenceSourceIds?: unknown } | null;
}): string[] {
  const cited = jsonStringArray(action.finding?.evidenceSourceIds);
  if (cited.length > 0) return cited;
  return jsonStringArray(record(action.evidence).source_ids);
}

export function selectEvidenceSources<T extends { id: string }>(
  sources: T[],
  sourceIds: string[],
): T[] {
  if (sourceIds.length === 0) return [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  const seen = new Set<string>();
  const selected: T[] = [];
  for (const id of sourceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const source = byId.get(id);
    if (source) selected.push(source);
  }
  return selected;
}

export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function sourceHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

export function sourcePublisher(source: {
  provider: string;
  community?: string | null;
  metadata?: unknown;
}): string | null {
  const publisher = record(source.metadata).publisher;
  if (typeof publisher === "string" && publisher.trim()) return publisher.trim();
  if (source.community?.trim()) return source.community.trim();
  return null;
}

export function sourceProviderLabel(provider: string): string {
  if (provider === "google_news_rss") return "Google News RSS";
  if (provider === "reddit_rss") return "Reddit RSS";
  return provider.replaceAll("_", " ");
}

export type KeywordEvidenceSummary = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string | null;
  queuedAt: string | null;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function keywordEvidenceForAction(evidence: unknown): KeywordEvidenceSummary | null {
  const keyword = record(record(evidence).keyword_research);
  if (typeof keyword.keyword !== "string" || !keyword.keyword.trim()) return null;
  return {
    keyword: keyword.keyword.trim(),
    volume: finiteNumber(keyword.volume),
    difficulty: finiteNumber(keyword.difficulty),
    cpc: finiteNumber(keyword.cpc),
    competition: finiteNumber(keyword.competition),
    intent: typeof keyword.intent === "string" ? keyword.intent : null,
    queuedAt: typeof keyword.queued_at === "string" ? keyword.queued_at : null,
  };
}
