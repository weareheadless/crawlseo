import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { resolveSiteContext } from "@/lib/site/context";
import { htmlToText } from "@/lib/projects/business-knowledge-extract";
import {
  RECOMMENDATION_POLICY_VERSION,
  sealPacket,
  type EvidencePacket,
  type PacketPage,
} from "@/lib/recommendation/contracts";

/**
 * Build the one evidence packet every assessment receives.
 *
 * Production, reassessment and evaluation call this function. There is no second
 * retrieval or ranking implementation, because a different input path cannot prove
 * what the monthly pipeline does.
 *
 * The packet is deliberately finite and explicit: selected page sections, the
 * known inventory, sources, business facts and the limitations of what was read.
 * Lexical matching chooses candidate sections; it does not judge whether they
 * answer the question.
 */

export type PacketDb = Pick<
  PrismaClient,
  | "site"
  | "crawl"
  | "auditPage"
  | "researchFinding"
  | "researchSource"
  | "businessKnowledgeDocument"
  | "businessKnowledgeRevision"
  | "evidenceRecord"
  | "siteProfile"
>;

export type PacketCandidate = {
  findingId: string;
  dedupKey: string;
  findingType: string;
  theme: string;
  summary: string;
  premise: string | null;
  observedAt: Date;
  sourceIds: string[];
};

export type PacketOptions = {
  projectId: string;
  siteId: string;
  candidate: PacketCandidate;
  maxPages?: number;
  maxCharsPerPage?: number;
  maxSources?: number;
  /** Read-only evaluation may supply facts extracted from live pages. */
  businessFacts?: EvidencePacket["businessFacts"];
  now?: Date;
};

const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_CHARS = 2_500;
const DEFAULT_MAX_SOURCES = 8;
const MAX_INVENTORY = 200;
const MAX_SEARCH = 40;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "without", "from", "this", "that", "these", "those",
  "our", "your", "their", "are", "was", "were", "have", "has", "had", "will", "would",
  "can", "could", "should", "not", "but", "they", "them", "there", "what", "when",
  "where", "which", "who", "how", "why", "all", "any", "some", "more", "most",
  "les", "des", "une", "aux", "pour", "avec", "sans", "dans", "sur", "est", "sont",
  "que", "qui", "pas", "plus", "mais", "leur", "leurs", "cette", "ces", "son", "sa",
  "los", "las", "una", "unos", "unas", "para", "con", "sin", "por", "como", "del",
  "más", "pero", "sus", "este", "esta", "estos", "estas", "page", "pages", "site",
  "website", "content", "contenu", "section", "article", "articles", "post", "blog",
  "candidate", "candidat", "addresses", "address", "explains", "explain", "covers",
  "cover", "answers", "answer", "missing", "absent", "dedicated", "dédiée",
]);

/** Unicode-safe terms: the old ASCII split discarded non-Latin scripts entirely. */
export function packetTerms(...values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const token of value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (token.length < 3 || STOPWORDS.has(token) || seen.has(token)) continue;
      seen.add(token);
      terms.push(token);
    }
  }
  return terms;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function pageId(url: string): string {
  return `page:${shortHash(url)}`;
}

/** Bounded fallback when the crawl stored no text. It uses the same public page. */
async function fetchLiveText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "CrawlSEO recommendation evidence (+https://crawlseo.app)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const text = htmlToText(await response.text()).slice(0, 8_000);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

function sourceId(id: string): string {
  return `source:${id}`;
}

function factId(field: string): string {
  return `fact:${field}`;
}

function searchId(id: string): string {
  return `search:${id}`;
}

function factValue(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const row = value as { value?: unknown };
  if (typeof row.value === "string") return [row.value];
  if (Array.isArray(row.value)) return row.value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function factMeta(value: unknown): { sourceUrl: string | null; provenanceKind: string; provenanceStatus: string; publicationUse: string } {
  if (!value || typeof value !== "object") {
    return { sourceUrl: null, provenanceKind: "unknown", provenanceStatus: "unknown", publicationUse: "unknown" };
  }
  const row = value as {
    provenance?: { evidenceUri?: unknown; kind?: unknown; status?: unknown };
    publicationUse?: unknown;
  };
  return {
    sourceUrl: typeof row.provenance?.evidenceUri === "string" ? row.provenance.evidenceUri : null,
    provenanceKind: typeof row.provenance?.kind === "string" ? row.provenance.kind : "unknown",
    provenanceStatus: typeof row.provenance?.status === "string" ? row.provenance.status : "unknown",
    publicationUse: typeof row.publicationUse === "string" ? row.publicationUse : "unknown",
  };
}

function metric(metrics: unknown, key: string): number | null {
  const value = (metrics as Record<string, { value?: unknown } | undefined> | null)?.[key]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dimension(dimensions: unknown, key: string): string | null {
  const value = (dimensions as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
}

/** Build overlapping windows around the need's terms, not a fixed page prefix. */
export function relevantSections(text: string, terms: string[], maxChars: number): Array<{ locator: string; text: string }> {
  if (!text.trim()) return [];
  const lower = text.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
  const windows: Array<{ start: number; end: number }> = [];
  const windowSize = Math.max(700, Math.min(1_600, Math.floor(maxChars / 2)));
  for (const term of terms.slice(0, 8)) {
    let index = lower.indexOf(term);
    let found = 0;
    while (index >= 0 && found < 2) {
      windows.push({ start: Math.max(0, index - Math.floor(windowSize / 3)), end: Math.min(text.length, index + windowSize) });
      index = lower.indexOf(term, index + term.length);
      found += 1;
    }
  }
  if (windows.length === 0) {
    windows.push({ start: 0, end: Math.min(text.length, maxChars) });
  }
  windows.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end + 80) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  const sections: Array<{ locator: string; text: string }> = [];
  let budget = maxChars;
  for (const window of merged) {
    if (budget <= 0) break;
    const slice = text.slice(window.start, Math.min(window.end, window.start + budget)).replace(/\s+/g, " ").trim();
    if (!slice) continue;
    sections.push({ locator: `chars:${window.start}-${window.start + slice.length}`, text: slice });
    budget -= slice.length;
  }
  return sections.slice(0, 8);
}

function buildPage(row: {
  url: string;
  title: string | null;
  contentText: string | null;
  contentHash: string | null;
  statusCode: number;
  language: string | null;
}, terms: string[], maxChars: number): PacketPage {
  const text = row.contentText ?? "";
  const selected = relevantSections(text, terms, maxChars);
  const supplied = selected.map((section) => section.text).join("\n\n");
  const truncated = supplied.length < text.length;
  const id = pageId(row.url);
  return {
    id,
    url: row.url,
    title: row.title,
    contentHash: row.contentHash,
    text: supplied,
    truncated,
    retrieval: text ? "stored" : "unavailable",
    status: row.statusCode,
    language: row.language,
    sections: selected.map((section, index) => ({
      id: `section:${id}:${index}`,
      locator: section.locator,
      text: section.text,
    })),
  };
}

export async function buildEvidencePacket(db: PacketDb, opts: PacketOptions): Promise<EvidencePacket> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, 10));
  const maxChars = Math.max(1_000, Math.min(opts.maxCharsPerPage ?? DEFAULT_MAX_CHARS, 8_000));
  const maxSources = Math.max(1, Math.min(opts.maxSources ?? DEFAULT_MAX_SOURCES, 20));
  const limitations: string[] = [];

  const site = await db.site.findUnique({
    where: { id: opts.siteId },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site || site.projectId !== opts.projectId) throw new Error("packet site does not belong to the project");

  const context = await resolveSiteContext(db, opts.siteId).catch(() => null);
  if (!context) limitations.push("site language/market context could not be resolved");
  if (context && context.source.language !== "business_knowledge" && context.source.language !== "site_profile") {
    limitations.push(`language was inferred from ${context.source.language}`);
  }

  const document = await db.businessKnowledgeDocument.findUnique({
    where: { projectId: opts.projectId },
    select: { id: true, revision: true, acceptedRevision: true },
  });
  const revisionNumber = document ? (document.acceptedRevision ?? document.revision) : null;
  const revision = document && revisionNumber != null
    ? await db.businessKnowledgeRevision.findFirst({
        where: { documentId: document.id, revision: revisionNumber },
        select: { fields: true },
      })
    : null;
  const businessFacts: EvidencePacket["businessFacts"] = [];
  if (!document) {
    limitations.push("no business knowledge document exists; offer fit may be unverified");
  } else if (revision?.fields && typeof revision.fields === "object" && !Array.isArray(revision.fields)) {
    for (const [field, value] of Object.entries(revision.fields as Record<string, unknown>)) {
      const values = factValue(value);
      if (values.length === 0) continue;
      const meta = factMeta(value);
      if (meta.publicationUse === "prohibited") continue;
      businessFacts.push({
        id: factId(field),
        field,
        value: values.join("; "),
        sourceUrl: meta.sourceUrl,
        provenanceKind: meta.provenanceKind,
        provenanceStatus: meta.provenanceStatus,
        publicationUse: meta.publicationUse,
        documentRevision: revisionNumber,
      });
    }
    if (document.acceptedRevision == null) limitations.push("business knowledge is a working revision, not owner-accepted");
  }

  const crawl = await db.crawl.findFirst({
    where: { siteId: opts.siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, pagesFound: true, maxPages: true, finishedAt: true },
  });
  if (!crawl) limitations.push("no completed crawl exists; site coverage cannot be assessed");

  const rows: Array<{
    url: string;
    title: string | null;
    contentText: string | null;
    contentHash: string | null;
    statusCode: number;
    indexable: boolean;
  }> = [];
  if (crawl) {
    for (let skip = 0; skip < MAX_INVENTORY; skip += 500) {
      const batch = await db.auditPage.findMany({
        where: { crawlId: crawl.id },
        select: { url: true, title: true, contentText: true, contentHash: true, statusCode: true, indexable: true },
        orderBy: { url: "asc" },
        skip,
        take: 500,
      });
      rows.push(...batch);
      if (batch.length < 500) break;
    }
    if (rows.length >= MAX_INVENTORY) limitations.push(`inventory was limited to ${MAX_INVENTORY} pages`);
    if (crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages) {
      limitations.push(`the crawl reached its ${crawl.maxPages}-page cap, so the inventory is incomplete`);
    }
    if (rows.some((row) => row.statusCode !== 200)) {
      limitations.push("some known pages returned a non-200 status and could not be assessed");
    }
    if (rows.some((row) => !row.contentText)) {
      limitations.push("some known pages have no stored text; their content is unknown, not absent");
    }
  }

  const terms = packetTerms(opts.candidate.theme, opts.candidate.summary, opts.candidate.premise);
  const ranked = rows
    .map((row) => {
      const haystack = `${row.title ?? ""} ${row.url} ${(row.contentText ?? "").slice(0, 4_000)}`
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { row, score };
    })
    .sort((a, b) => b.score - a.score || a.row.url.length - b.row.url.length);
  const selectedRows = ranked.filter((entry) => entry.score > 0).slice(0, maxPages).map((entry) => entry.row);
  const root = rows.find((row) => {
    try {
      return new URL(row.url).pathname === "/";
    } catch {
      return false;
    }
  });
  if (root && !selectedRows.some((row) => row.url === root.url)) selectedRows.unshift(root);
  const pages: PacketPage[] = [];
  let liveFetches = 0;
  for (const row of selectedRows.slice(0, maxPages)) {
    let contentText = row.contentText;
    if (!contentText && row.statusCode === 200 && liveFetches < 3) {
      const live = await fetchLiveText(row.url);
      if (live) {
        contentText = live;
        liveFetches += 1;
        limitations.push(`page text for ${row.url} came from a bounded live fetch, not the stored crawl`);
      }
    }
    pages.push(buildPage({ ...row, contentText, language: context?.language ?? null }, terms, maxChars));
  }
  if (pages.some((page) => page.truncated)) {
    limitations.push("selected page text was sectioned or truncated; unread sections are unknown");
  }
  if (pages.length === 0) limitations.push("no relevant page text was selected for assessment");

  const sourceRows = opts.candidate.sourceIds.length
    ? await db.researchSource.findMany({
        where: { id: { in: opts.candidate.sourceIds.slice(0, maxSources) } },
        select: { id: true, url: true, title: true, provider: true, excerpt: true, retrievedAt: true, language: true },
      })
    : [];
  if (sourceRows.length === 0) limitations.push("the candidate has no research source text; need support is unknown");

  const searchRows = await db.evidenceRecord.findMany({
    where: { projectId: opts.projectId, kind: { in: ["gsc_query", "gsc_page", "keyword_metrics"] }, supersededById: null },
    select: { id: true, kind: true, dimensions: true, metrics: true },
    orderBy: { observedAt: "desc" },
    take: MAX_SEARCH,
  });
  const effectiveFacts = opts.businessFacts ?? businessFacts;
  const search: EvidencePacket["search"] = searchRows.map((row) => ({
    id: searchId(row.id),
    query: dimension(row.dimensions, "query") ?? dimension(row.dimensions, "url") ?? "",
    pageUrl: dimension(row.dimensions, "url"),
    windowStart: dimension(row.dimensions, "windowStart"),
    windowEnd: dimension(row.dimensions, "windowEnd"),
    clicks: metric(row.metrics, "first_party:clicks"),
    impressions: metric(row.metrics, "first_party:impressions"),
    position: metric(row.metrics, "first_party:position"),
    ctr: metric(row.metrics, "first_party:ctr"),
    source: row.kind,
  }));

  return sealPacket(
    {
      projectId: opts.projectId,
      siteId: opts.siteId,
      policyVersion: RECOMMENDATION_POLICY_VERSION,
      candidate: {
        findingId: opts.candidate.findingId,
        findingType: opts.candidate.findingType,
        theme: opts.candidate.theme,
        summary: opts.candidate.summary,
        premise: opts.candidate.premise,
        observedAt: opts.candidate.observedAt.toISOString(),
        dedupKey: opts.candidate.dedupKey,
        sourceIds: opts.candidate.sourceIds,
      },
      businessFacts: effectiveFacts,
      context: {
        language: context?.language ?? null,
        audience: context?.audience ?? null,
        market: context?.audienceMarket ?? context?.market ?? null,
        marketSource: context?.source.audienceCountry ?? context?.source.country ?? null,
      },
      sources: sourceRows.map((row) => ({
        id: sourceId(row.id),
        url: row.url,
        title: row.title,
        provider: row.provider,
        excerpt: row.excerpt,
        observedAt: row.retrievedAt.toISOString(),
        language: row.language,
      })),
      pages,
      inventory: rows.slice(0, MAX_INVENTORY).map((row) => ({
        url: row.url,
        title: row.title,
        status: row.statusCode,
        indexable: row.indexable,
        retrieval: row.contentText ? "stored" : "unavailable",
      })),
      search,
      limitations,
    },
    opts.now ?? new Date()
  );
}
