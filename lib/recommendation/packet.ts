import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { documentMarkup, fetchPublicDocument } from "@/lib/crawler/engine";
import { htmlToText } from "@/lib/projects/business-knowledge-extract";
import { resolveSiteContext } from "@/lib/site/context";
import {
  RECOMMENDATION_POLICY_VERSION,
  sealPacket,
  type EvidencePacket,
  type PacketLink,
  type PacketPage,
  type ResolvedEvidenceRequest,
} from "@/lib/recommendation/contracts";

/**
 * Build the one evidence packet every assessment receives.
 *
 * Production, reassessment, shadow and evaluation call this module. There is no
 * second retrieval or ranking implementation, because a different input path
 * cannot prove what the monthly pipeline does.
 *
 * Lexical matching chooses candidate sections; it does not judge whether they
 * answer the question. Selection is relevance-first, so the homepage cannot
 * consume the page budget merely by existing. When stored text is missing the
 * service may retrieve the page through the existing safe fetch path, and the
 * model may request more evidence before it returns a final decision.
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
  maxLiveFetches?: number;
  /** Called before each network fetch; throw to stop before dispatch. */
  beforeFetch?: () => void;
  /** Reports the bytes actually read for budget accounting. */
  onBytes?: (bytes: number) => void;
  now?: Date;
};

const DEFAULT_MAX_PAGES = 6;
const DEFAULT_MAX_CHARS = 3_000;
const DEFAULT_MAX_SOURCES = 8;
const MAX_INVENTORY = 500;
const MAX_SEARCH = 40;
const MAX_LINKS = 200;
const MAX_LIVE_CHARS = 120_000;

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

/** Unicode-safe terms: an ASCII split would discard non-Latin scripts entirely. */
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

function sourceId(id: string): string {
  return `source:${id}`;
}

function factId(field: string): string {
  return `fact:${field}`;
}

function searchId(id: string): string {
  return `search:${id}`;
}

/** A lower-cased, accent-folded string plus a map back to original offsets. */
function normaliseWithMap(text: string): { lower: string; map: number[] } {
  let lower = "";
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const folded = text[index].normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    for (const char of folded) {
      lower += char;
      map.push(index);
    }
  }
  map.push(text.length);
  return { lower, map };
}

/**
 * Build overlapping windows around the need's terms, on the original text.
 *
 * The old implementation searched a whitespace-normalised copy and then sliced
 * the original with those offsets, which shifted every section after the first
 * collapsed space. The index map keeps offsets honest.
 */
export function relevantSections(text: string, terms: string[], maxChars: number): Array<{ locator: string; text: string }> {
  if (!text.trim()) return [];
  const { lower, map } = normaliseWithMap(text);
  const windows: Array<{ start: number; end: number }> = [];
  const windowSize = Math.max(700, Math.min(1_800, Math.floor(maxChars / 2)));
  for (const term of terms.slice(0, 10)) {
    let index = lower.indexOf(term);
    let found = 0;
    while (index >= 0 && found < 2) {
      const start = map[Math.max(0, index - Math.floor(windowSize / 3))] ?? 0;
      const end = map[Math.min(lower.length, index + windowSize)] ?? text.length;
      windows.push({ start, end });
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
    if (last && window.start <= last.end + 120) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  const sections: Array<{ locator: string; text: string }> = [];
  let budget = maxChars;
  for (const window of merged) {
    if (budget <= 0) break;
    const slice = text
      .slice(window.start, Math.min(window.end, window.start + budget))
      .replace(/\s+/g, " ")
      .trim();
    if (!slice) continue;
    sections.push({ locator: `chars:${window.start}-${window.start + slice.length}`, text: slice });
    budget -= slice.length;
  }
  return sections.slice(0, 8);
}

type RetrievedPage = {
  url: string;
  title: string | null;
  text: string;
  html: string;
  status: number;
  finalUrl: string;
  note: string | null;
  retrieval: "live" | "unavailable";
  bytes: number;
};

const SHELL_MARKERS = /enable javascript|javascript is required|access denied|just a moment|attention required|captcha|cf-challenge|please verify you are human/i;

/**
 * Bounded retrieval through the crawler's safe public-document path.
 *
 * Redirects are followed manually and every hop is checked before dispatch. The
 * body is streamed to a byte cap and returned with an explicit truncation flag.
 */
export async function retrievePage(
  url: string,
  siteDomain: string,
  opts: { beforeHop?: () => void; maxBytes?: number } = {}
): Promise<RetrievedPage> {
  const domain = siteDomain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { url, title: null, text: "", html: "", status: 0, finalUrl: url, note: "invalid URL", retrieval: "unavailable", bytes: 0 };
  }
  const host = target.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== domain && !host.endsWith(`.${domain}`)) {
    return { url, title: null, text: "", html: "", status: 0, finalUrl: url, note: "URL is outside the site domain", retrieval: "unavailable", bytes: 0 };
  }
  try {
    const doc = await fetchPublicDocument(target.toString(), {
      maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
      timeoutMs: 20_000,
      beforeHop: () => {
        opts.beforeHop?.();
      },
    });
    const finalUrl = doc.finalUrl || url;
    const finalHost = new URL(finalUrl).hostname.replace(/^www\./, "").toLowerCase();
    if (finalHost !== domain && !finalHost.endsWith(`.${domain}`)) {
      return { url, title: null, text: "", html: "", status: doc.statusCode, finalUrl, note: "redirect left the site domain", retrieval: "unavailable", bytes: doc.bytes };
    }
    if (!doc.contentType.includes("html") && !doc.contentType.includes("xml")) {
      return { url, title: null, text: "", html: "", status: doc.statusCode, finalUrl, note: `non-HTML content (${doc.contentType || "unknown"})`, retrieval: "unavailable", bytes: doc.bytes };
    }
    const html = doc.html;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
    // Wix and similar builders embed base64 payloads inside comments and
    // templates; stripping tags alone would hand the model encoded noise.
    const text = htmlToText(documentMarkup(html)).slice(0, MAX_LIVE_CHARS);
    if (doc.statusCode !== 200) {
      return { url, title, text: "", html, status: doc.statusCode, finalUrl, note: `HTTP ${doc.statusCode}`, retrieval: "unavailable", bytes: doc.bytes };
    }
    if (SHELL_MARKERS.test(html) && text.length < 1_500) {
      return { url, title, text: "", html, status: doc.statusCode, finalUrl, note: "page is a bot challenge or client-rendered shell", retrieval: "unavailable", bytes: doc.bytes };
    }
    if (text.length < 80) {
      return { url, title, text: "", html, status: doc.statusCode, finalUrl, note: "no usable body text was extracted", retrieval: "unavailable", bytes: doc.bytes };
    }
    return {
      url,
      title,
      text,
      html,
      status: doc.statusCode,
      finalUrl,
      note: doc.truncated ? "document exceeded the byte limit; text may be incomplete" : null,
      retrieval: "live",
      bytes: doc.bytes,
    };
  } catch (error) {
    return {
      url,
      title: null,
      text: "",
      html: "",
      status: 0,
      finalUrl: url,
      note: error instanceof Error ? error.message.slice(0, 300) : "retrieval failed",
      retrieval: "unavailable",
      bytes: 0,
    };
  }
}

export function extractInternalLinks(html: string, fromUrl: string, siteDomain: string): Array<{ toUrl: string; anchor: string }> {
  const domain = siteDomain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
  const links: Array<{ toUrl: string; anchor: string }> = [];
  const seen = new Set<string>();
  for (const match of documentMarkup(html).matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let absolute: string;
    try {
      absolute = new URL(match[1], fromUrl).toString();
    } catch {
      continue;
    }
    const host = new URL(absolute).hostname.replace(/^www\./, "").toLowerCase();
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    const anchor = htmlToText(match[2]).slice(0, 200);
    const key = `${absolute}|${anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ toUrl: absolute, anchor });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

function buildPage(
  row: {
    url: string;
    title: string | null;
    contentText: string | null;
    contentHash: string | null;
    statusCode: number;
    language: string | null;
    retrieval: "stored" | "live" | "unavailable";
    retrievalNote: string | null;
  },
  terms: string[],
  maxChars: number
): PacketPage {
  const text = row.contentText ?? "";
  const selected = relevantSections(text, terms, maxChars);
  const supplied = selected.map((section) => section.text).join("\n\n");
  const truncated = supplied.length < text.length;
  const id = pageId(row.url);
  return {
    id,
    url: row.url,
    title: row.title,
    contentHash: row.contentHash ?? (text ? createHash("sha256").update(text).digest("hex") : null),
    text: supplied,
    truncated,
    retrieval: row.retrieval,
    status: row.statusCode,
    language: row.language,
    inspected: supplied.length,
    totalChars: text.length,
    retrievalNote: row.retrievalNote,
    sections: selected.map((section, index) => ({
      id: `section:${id}:${index}`,
      locator: section.locator,
      text: section.text,
    })),
  };
}

/** A requested page is supplied whole, not re-sectioned, so it can be assessed. */
function buildFullPage(
  row: {
    url: string;
    title: string | null;
    contentText: string | null;
    contentHash: string | null;
    statusCode: number;
    language: string | null;
    retrieval: "stored" | "live" | "unavailable";
    retrievalNote: string | null;
  },
  maxChars: number
): PacketPage {
  const full = row.contentText ?? "";
  const text = full.slice(0, maxChars);
  const id = pageId(row.url);
  return {
    id,
    url: row.url,
    title: row.title,
    contentHash: row.contentHash ?? (full ? createHash("sha256").update(full).digest("hex") : null),
    text,
    truncated: full.length > maxChars,
    retrieval: row.retrieval,
    status: row.statusCode,
    language: row.language,
    inspected: text.length,
    totalChars: full.length,
    retrievalNote: row.retrievalNote,
    sections: text
      ? [{ id: `section:${id}:0`, locator: `chars:0-${text.length}`, text }]
      : [],
  };
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

export type InventoryRow = {
  url: string;
  title: string | null;
  contentText: string | null;
  contentHash: string | null;
  statusCode: number;
  indexable: boolean;
};

/** The complete known inventory, bounded only by the existing crawl size. */
export async function loadInventory(db: PacketDb, crawlId: string): Promise<InventoryRow[]> {
  return db.auditPage.findMany({
    where: { crawlId },
    select: { url: true, title: true, contentText: true, contentHash: true, statusCode: true, indexable: true },
    orderBy: { url: "asc" },
    take: MAX_INVENTORY,
  });
}

function rankRows(rows: InventoryRow[], terms: string[]): Array<{ row: InventoryRow; score: number }> {
  return rows
    .map((row) => {
      const haystack = `${row.title ?? ""} ${row.url} ${(row.contentText ?? "").slice(0, 6_000)}`
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { row, score };
    })
    .sort((a, b) => b.score - a.score || a.row.url.length - b.row.url.length);
}

export async function buildEvidencePacket(db: PacketDb, opts: PacketOptions): Promise<EvidencePacket> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, 10));
  const maxChars = Math.max(800, Math.min(opts.maxCharsPerPage ?? DEFAULT_MAX_CHARS, 8_000));
  const maxSources = Math.max(1, Math.min(opts.maxSources ?? DEFAULT_MAX_SOURCES, 20));
  const maxLiveFetches = Math.max(0, Math.min(opts.maxLiveFetches ?? 4, 6));
  const limitations: string[] = [];
  const trace: EvidencePacket["trace"] = [];
  const requests: EvidencePacket["requests"] = [];

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
  if (document && businessFacts.length === 0) {
    limitations.push("the business knowledge document contains no usable facts; offer fit may be unverified");
  }

  const crawl = await db.crawl.findFirst({
    where: { siteId: opts.siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, pagesFound: true, maxPages: true, finishedAt: true },
  });
  if (!crawl) limitations.push("no completed crawl exists; site coverage cannot be assessed");

  const rows = crawl ? await loadInventory(db, crawl.id) : [];
  if (crawl) {
    if (rows.length >= MAX_INVENTORY) limitations.push(`inventory was limited to ${MAX_INVENTORY} known pages`);
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
  const ranked = rankRows(rows, terms);
  const selectedRows = ranked.filter((entry) => entry.score > 0).slice(0, maxPages).map((entry) => entry.row);
  if (selectedRows.length < 2) {
    for (const entry of ranked) {
      if (selectedRows.length >= Math.min(2, maxPages)) break;
      if (!selectedRows.some((row) => row.url === entry.row.url)) selectedRows.push(entry.row);
    }
  }
  if (selectedRows.length === 0 && rows.length > 0) selectedRows.push(rows[0]);

  const pages: PacketPage[] = [];
  let liveFetches = 0;
  for (const row of selectedRows.slice(0, maxPages)) {
    let contentText = row.contentText;
    let retrieval: "stored" | "live" | "unavailable" = contentText ? "stored" : "unavailable";
    let note: string | null = contentText ? null : "no stored page text";
    let title = row.title;
    let statusCode = row.statusCode;
    if (!contentText && row.statusCode === 200 && liveFetches < maxLiveFetches) {
      let live: RetrievedPage;
      try {
        live = await retrievePage(row.url, site.domain, { beforeHop: opts.beforeFetch });
        opts.onBytes?.(live.bytes);
      } catch (error) {
        limitations.push(`page text for ${row.url} was not retrieved: ${error instanceof Error ? error.message.slice(0, 200) : "budget exhausted"}`);
        pages.push(
          buildPage(
            { url: row.url, title, contentText: null, contentHash: row.contentHash, statusCode, language: context?.language ?? null, retrieval: "unavailable", retrievalNote: "fetch budget exhausted" },
            terms,
            maxChars
          )
        );
        continue;
      }
      liveFetches += 1;
      if (live.retrieval === "live") {
        contentText = live.text;
        retrieval = "live";
        note = null;
        title = live.title ?? title;
        statusCode = live.status;
        limitations.push(`page text for ${row.url} came from a bounded live fetch, not the stored crawl`);
      } else {
        note = live.note;
        limitations.push(`page text for ${row.url} could not be retrieved: ${live.note}`);
      }
    }
    pages.push(
      buildPage(
        { url: row.url, title, contentText, contentHash: row.contentHash, statusCode, language: context?.language ?? null, retrieval, retrievalNote: note },
        terms,
        maxChars
      )
    );
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

  trace.push({
    round: 0,
    action: "packet",
    detail: `assembled ${pages.length} pages, ${sourceRows.length} sources, ${effectiveFacts.length} facts`,
    at: new Date().toISOString(),
  });

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
      links: [],
      requests,
      trace,
      inventory: rows.slice(0, MAX_INVENTORY).map((row) => ({
        url: row.url,
        title: row.title,
        status: row.statusCode,
        indexable: row.indexable,
        retrieval: row.contentText ? "stored" : "unavailable",
      })),
      search,
      limitations: limitations.slice(0, 20),
    },
    opts.now ?? new Date()
  );
}

export type ExpandResult = {
  packet: EvidencePacket;
  actions: string[];
  requested: number;
  retrieved: number;
  failed: number;
  progress: boolean;
};

/**
 * Resolve evidence requests against the site and return a new sealed packet.
 *
 * Requests never authorise a new web crawl: page retrieval is limited to the
 * site's own origin, and inventory discovery only searches known URLs. A request
 * that cannot be satisfied becomes an explicit limitation, not an absence claim.
 */
export async function expandEvidencePacket(
  db: PacketDb,
  packet: EvidencePacket,
  resolved: ResolvedEvidenceRequest[],
  opts: {
    siteDomain: string;
    maxLiveFetches?: number;
    round?: number;
    beforeFetch?: () => void;
    onBytes?: (bytes: number) => void;
    now?: Date;
  }
): Promise<ExpandResult> {
  const pages = packet.pages.map((page) => ({ ...page, sections: page.sections.map((section) => ({ ...section })) }));
  const links: PacketLink[] = packet.links.map((link) => ({ ...link }));
  const limitations = [...packet.limitations];
  const trace = [...packet.trace];
  const requests = [...packet.requests];
  const actions: string[] = [];
  const terms = packetTerms(packet.candidate.theme, packet.candidate.summary, packet.candidate.premise);
  const maxFetches = Math.max(0, Math.min(opts.maxLiveFetches ?? 4, 6));
  const requestedFullText = 20_000;
  let fetches = 0;
  let retrieved = 0;
  let failed = 0;
  let progress = false;

  const site = await db.site.findUnique({ where: { id: packet.siteId }, select: { domain: true } });
  const domain = opts.siteDomain || site?.domain || "";
  const round = opts.round ?? 1;

  const upsertPage = async (url: string) => {
    const existingIndex = pages.findIndex((page) => page.url === url);
    const existing = existingIndex >= 0 ? pages[existingIndex] : null;
    // A requested page must be supplied in full enough to assess. Sectioning a
    // page again would make the model request it forever.
    if (existing && existing.text.trim() && !existing.truncated) return existing;
    if (fetches >= maxFetches) {
      limitations.push(`evidence request for ${url} was not retrieved: live-fetch limit reached`);
      return existing;
    }
    fetches += 1;
    let live: RetrievedPage;
    try {
      live = await retrievePage(url, domain, { beforeHop: opts.beforeFetch });
      opts.onBytes?.(live.bytes);
    } catch {
      limitations.push(`evidence request for ${url} was not retrieved: fetch budget exhausted`);
      return existing;
    }
    if (live.retrieval !== "live") {
      failed += 1;
      const note = live.note ?? "retrieval failed";
      limitations.push(`evidence request for ${url} failed: ${note}`);
      if (existing) {
        existing.retrieval = "unavailable";
        existing.retrievalNote = note;
      }
      return existing;
    }
    retrieved += 1;
    const page = buildFullPage(
      {
        url,
        title: live.title,
        contentText: live.text,
        contentHash: createHash("sha256").update(live.text).digest("hex"),
        statusCode: live.status,
        language: existing?.language ?? packet.context.language,
        retrieval: "live",
        retrievalNote: null,
      },
      requestedFullText
    );
    limitations.push(`page text for ${url} was retrieved on request and is not stored crawl text`);
    if (existingIndex >= 0) pages[existingIndex] = page;
    else if (pages.length < 10) pages.push(page);
    return page;
  };

  for (const request of resolved) {
    if (request.type === "page_text" || request.type === "inventory_search") {
      if (!request.url) {
        failed += 1;
        requests.push({ type: request.type, target: request.target, status: "unavailable", detail: "no retrievable URL" });
        actions.push(`${request.type} ${request.target}: no retrievable URL`);
        continue;
      }
      const before = pages.find((page) => page.url === request.url);
      const page = await upsertPage(request.url);
      const supplied = Boolean(page?.text.trim());
      if (!supplied) {
        failed += 1;
        const budget = limitations.some((line) => line.includes("fetch budget exhausted") || line.includes("live-fetch limit reached"));
        requests.push({
          type: request.type,
          target: request.target,
          status: budget ? "budget_exhausted" : "unavailable",
          detail: page?.retrievalNote ?? "no text could be retrieved",
        });
        actions.push(`${request.type} ${request.target}: unavailable`);
        continue;
      }
      const changed = !before || before.text !== page?.text;
      const status = changed || page?.retrieval === "live" ? "fulfilled" : "partial";
      if (status === "fulfilled") progress = true;
      requests.push({
        type: request.type,
        target: request.target,
        status,
        detail: status === "fulfilled" ? "page text supplied" : "page text was already supplied",
      });
      actions.push(`${request.type} ${request.target}: ${status}`);
      continue;
    }
    if (request.type === "source_text") {
      const source = packet.sources.find((entry) => entry.id === request.target);
      if (!source) {
        failed += 1;
        requests.push({ type: "source_text", target: request.target, status: "unavailable", detail: "source is not in the packet" });
        actions.push(`source_text ${request.target}: not in packet`);
        continue;
      }
      limitations.push(`source ${source.url} has only a stored excerpt; external full-text retrieval is not authorised`);
      requests.push({
        type: "source_text",
        target: request.target,
        status: "unavailable",
        detail: "only a stored excerpt exists and external full-text retrieval is not authorised",
      });
      actions.push(`source_text ${request.target}: unavailable (excerpt only)`);
      continue;
    }
    // journey_links
    let page = request.pageId ? pages.find((entry) => entry.id === request.pageId) : undefined;
    if (!page && request.url) {
      page = (await upsertPage(request.url)) ?? undefined;
    }
    if (!page) {
      failed += 1;
      requests.push({ type: "journey_links", target: request.target, status: "unavailable", detail: "page not in packet" });
      actions.push(`journey_links ${request.target}: page not in packet`);
      continue;
    }
    if (!page.text.trim()) {
      const fetched = await upsertPage(page.url);
      if (!fetched?.text.trim()) {
        failed += 1;
        requests.push({ type: "journey_links", target: request.target, status: "unavailable", detail: "page text unavailable, links unknown" });
        actions.push(`journey_links ${page.url}: page text unavailable, links unknown`);
        continue;
      }
    }
    if (fetches >= maxFetches) {
      failed += 1;
      limitations.push(`journey links for ${page.url} were not inspected: live-fetch limit reached`);
      requests.push({ type: "journey_links", target: request.target, status: "budget_exhausted", detail: "live-fetch limit reached" });
      continue;
    }
    fetches += 1;
    let live: RetrievedPage;
    try {
      live = await retrievePage(page.url, domain, { beforeHop: opts.beforeFetch });
      opts.onBytes?.(live.bytes);
    } catch {
      failed += 1;
      requests.push({ type: "journey_links", target: request.target, status: "budget_exhausted", detail: "fetch budget exhausted" });
      continue;
    }
    if (live.retrieval !== "live") {
      failed += 1;
      limitations.push(`journey links for ${page.url} could not be inspected: ${live.note ?? "retrieval failed"}`);
      requests.push({ type: "journey_links", target: request.target, status: "unavailable", detail: live.note ?? "retrieval failed" });
      continue;
    }
    const found = extractInternalLinks(live.html, live.finalUrl, domain);
    for (const link of found) {
      if (links.length >= MAX_LINKS) break;
      if (links.some((entry) => entry.fromPageId === page.id && entry.toUrl === link.toUrl && entry.anchor === link.anchor)) continue;
      links.push({ fromPageId: page.id, toUrl: link.toUrl, anchor: link.anchor, observation: "observed", status: null });
    }
    limitations.push(`journey links for ${page.url} are observed anchors only; destination status was not checked`);
    progress = progress || found.length > 0;
    requests.push({
      type: "journey_links",
      target: request.target,
      status: found.length > 0 ? "fulfilled" : "partial",
      detail: `${found.length} internal anchors observed; destination status not checked`,
    });
    actions.push(`journey_links ${page.url}: ${found.length} internal anchors observed`);
  }

  trace.push({
    round,
    action: "retrieval",
    detail: actions.join("; ").slice(0, 600) || "no request could be resolved",
    at: new Date().toISOString(),
  });

  const expanded = sealPacket(
    {
      projectId: packet.projectId,
      siteId: packet.siteId,
      policyVersion: packet.policyVersion,
      candidate: packet.candidate,
      businessFacts: packet.businessFacts,
      context: packet.context,
      sources: packet.sources,
      pages,
      links,
      requests,
      trace,
      inventory: packet.inventory,
      search: packet.search,
      limitations: limitations.slice(0, 20),
    },
    opts.now ?? new Date()
  );
  return { packet: expanded, actions, requested: resolved.length, retrieved, failed, progress };
}
