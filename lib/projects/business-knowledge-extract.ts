import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { writeBusinessKnowledge } from "@/lib/projects/business-knowledge";
import { hasUsableKnowledgeFields } from "@/lib/projects/business-knowledge-facts";
import { buildPageInventory } from "@/lib/research/page-inventory";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { chatJson } from "@/lib/ai/chat";

/**
 * Business knowledge extracted from the live site.
 *
 * This was a script, run by hand for one tenant, which meant every other tenant
 * had no business knowledge until someone remembered. The funnel's why-leg reads
 * business facts, so "no knowledge document" was quietly making the analysis
 * thinner for every tenant nobody had run it for.
 *
 * It is a library function now: the tenant pipeline calls it, the CLI calls the
 * pipeline, and nothing else decides whether a site has knowledge.
 *
 * What it produces is deliberately not owner-confirmed: a working revision with
 * `ai_observation` provenance, status `assumed`, `publicationUse: internal_only`.
 * Acceptance stays the owner's call.
 */

const MAX_PAGES = 10;
const MAX_CHARS_PER_PAGE = 6_000;

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPage(url: string): Promise<{ url: string; text: string; title: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "CrawlSEO business knowledge extractor (+https://crawlseo.app)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    return { url: res.url || url, text: htmlToText(html).slice(0, MAX_CHARS_PER_PAGE), title };
  } catch {
    return null;
  }
}

type Extracted = {
  contentLanguage?: string;
  businessName?: string;
  services?: string[];
  location?: string;
  serviceArea?: string[];
  differentiators?: string[];
  audienceMotivations?: string[];
  concerns?: string[];
  conversionGoals?: string[];
  voice?: string;
};

export type ExtractedKnowledge = {
  contentLanguage: string | null;
  /** The facts the model found, unvalidated and with no storage yet. */
  fields: Extracted;
  /** Which fields carried a value. */
  extracted: string[];
  pagesRead: number;
};

// Language-neutral on purpose: the prompt asks for the site's own language, so a
// French atelier and a Mexican agency get the same instruction.
const SYSTEM = `You extract business knowledge from a website for a company document.
Answer with JSON only, keys: contentLanguage (ISO 639-1 code of the pages' language),
businessName (text), services (list), location (text),
serviceArea (list), differentiators (list), audienceMotivations (list), concerns (list),
conversionGoals (list), voice (text).
Rules: invent nothing. If a fact does not appear explicitly on the pages, omit the key.
Values must be short, factual, in the language of the site content, and quoted verbatim when they are a name.
Always return a JSON object. Return {} when the pages contain no extractable business fact.`;

export type ExtractBusinessKnowledgeResult = {
  /**
   * The language the pages are written in, which is the only source of a language
   * for a site whose profile and TLD say nothing.
   */
  contentLanguage: string | null;
  /** Fields the model returned, so a caller can see what was found before writing. */
  extracted: string[];
  /** The values themselves, so an evaluation can inspect them without writing. */
  fields: Extracted;
  /** Fields no page contains verbatim: written without an evidence URI. */
  unattributed: string[];
  /** Pages the extractor read, with their retrieved text. */
  pageUrls: string[];
  documentId: string;
  revision: number;
  state: string;
  pagesRead: number;
  /** Where the pages came from, so a thin extraction is not mistaken for an empty site. */
  pagesFromCrawl: number;
  pagesFetched: number;
  pagesUnreadable: number;
};

type ExtractDb = PrismaClient;

/**
 * Extract business facts from pages that were already retrieved.
 *
 * Split from the storage path so an evaluation can run the real extractor against
 * a site without writing a knowledge revision, and so the product has one
 * extraction prompt rather than a second copy for tests.
 */
export async function extractBusinessKnowledgeFromPages(
  pages: Array<{ url: string; text: string; title: string }>
): Promise<ExtractedKnowledge> {
  if (pages.length === 0) throw new Error("no page could be fetched");

  const config = contentWriterConfig();
  if (!config) throw new Error("CONTENT_LLM_API_KEY is not configured");

  const userPrompt = pages
    .map((page, index) => `--- PAGE ${index + 1}: ${page.url}\nTITLE: ${page.title}\n${page.text}`)
    .join("\n\n");

  // A page that renders client-side yields almost no text, and the model answers
  // with nothing rather than an empty object. That is "no facts found", not a
  // failed step: the run continues and the step reports what it could not read.
  let parsed: Extracted = {};
  try {
    parsed = (await chatJson({
      config,
      system: SYSTEM,
      user: userPrompt,
      maxTokens: 3_000,
      attempts: 4,
    })) as Extracted;
  } catch (error) {
    if (!/empty response/i.test(error instanceof Error ? error.message : "")) throw error;
  }

  const contentLanguage =
    typeof parsed.contentLanguage === "string" && /^[a-z]{2}$/i.test(parsed.contentLanguage.trim())
      ? parsed.contentLanguage.trim().toLowerCase()
      : null;

  const extracted = Object.entries(parsed)
    .filter(([key, value]) => key !== "contentLanguage" && value !== undefined && value !== null)
    .map(([key]) => key);

  return { contentLanguage, fields: parsed, extracted, pagesRead: pages.length };
}

function sectionOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+/, "").split("/")[0] || "/";
  } catch {
    return "/";
  }
}

/**
 * Pages the site's own crawl already retrieved.
 *
 * The crawl stored the text, so re-fetching the same pages over HTTP was both
 * slower and the main reason extraction failed on sites behind a WAF. The sample
 * is the crawl's page-type inventory, so this reads the same pages the
 * synthesizer sees rather than a second, different selection.
 */
async function crawlExtractionPages(db: ExtractDb, siteId: string, limit: number) {
  const crawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  if (!crawl) return [];
  const inventory = buildPageInventory(
    await db.auditPage.findMany({ where: { crawlId: crawl.id }, select: { url: true, contentScore: true } }),
    limit
  );
  if (inventory.sampled.length === 0) return [];
  const stored = await db.auditPage.findMany({
    where: { crawlId: crawl.id, url: { in: inventory.sampled }, contentText: { not: null } },
    select: { url: true, title: true, contentText: true },
  });
  return stored
    .map((page) => ({ url: page.url, title: page.title ?? "", text: (page.contentText ?? "").slice(0, MAX_CHARS_PER_PAGE) }))
    .filter((page) => page.text.trim().length > 0);
}

/**
 * Read the site's own pages and write a working business-knowledge revision.
 *
 * Pages come from the latest completed crawl first (its text is already stored
 * and its sample covers every page type), then one representative per top-level
 * sitemap section the crawl did not reach, then the root. Traffic evidence ranks
 * the candidates only when the site has never been crawled. Every source is
 * counted in the result, so a thin extraction says why it was thin.
 */
export async function extractBusinessKnowledgeFromSite(
  db: ExtractDb,
  opts: { projectId: string; /** The site to read; without it, the project's first site. */ siteId?: string; dryRun?: boolean }
): Promise<ExtractBusinessKnowledgeResult> {
  const project = await db.project.findUniqueOrThrow({
    where: { id: opts.projectId },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      sites: {
        where: opts.siteId ? { id: opts.siteId } : undefined,
        select: { id: true, domain: true },
        take: 1,
        orderBy: { createdAt: "asc" },
      },
    },
  });
  const site = project.sites[0];
  if (!site) throw new Error(opts.siteId ? `project has no site ${opts.siteId}` : "project has no site");

  const crawlEvidence = await db.evidenceRecord.findMany({
    where: { projectId: project.id, kind: "gsc_page", supersededById: null },
    select: { dimensions: true, metrics: true },
  });
  const ranked = crawlEvidence
    .map((row) => ({
      url: (row.dimensions as { url?: string } | null)?.url ?? "",
      impressions: Number((row.metrics as Record<string, { value?: number }> | null)?.["first_party:impressions"]?.value ?? 0),
    }))
    .filter((row) => row.url)
    .sort((a, b) => b.impressions - a.impressions)
    .map((row) => row.url);

  const origin = `https://${site.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const sitemapSections: string[] = [];
  try {
    const xml = await (await fetch(`${origin}/sitemap.xml`, { signal: AbortSignal.timeout(15_000) })).text();
    const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => match[1].trim());
    const seen = new Set<string>();
    for (const loc of locs) {
      const path = new URL(loc).pathname.replace(/^\/+/, "");
      const section = path.split("/")[0] || "/";
      if (seen.has(section)) continue;
      seen.add(section);
      sitemapSections.push(loc);
    }
  } catch {
    // No sitemap: traffic pages and the root are still enough to start.
  }
  const pages = await crawlExtractionPages(db, site.id, MAX_PAGES);
  const fromCrawl = pages.length;
  const coveredSections = new Set(pages.map((page) => sectionOf(page.url)));
  // Without a crawl, traffic pages rank the fetch order; with one, the crawl's
  // page-type sample already leads and only uncovered sections are fetched.
  const candidates = [
    `${origin}/`,
    ...(fromCrawl === 0 ? ranked : []),
    ...sitemapSections.filter((url) => !coveredSections.has(sectionOf(url))),
  ];
  let pagesFetched = 0;
  let pagesUnreadable = 0;
  for (const url of [...new Set(candidates)]) {
    if (pages.length >= MAX_PAGES) break;
    if (pages.some((page) => page.url === url)) continue;
    const page = await fetchPage(url);
    pagesFetched += 1;
    if (page) pages.push(page);
    else pagesUnreadable += 1;
  }
  if (pages.length === 0) throw new Error("no page could be read: the crawl stored no text and no page could be fetched");

  const knowledge = await extractBusinessKnowledgeFromPages(pages);
  const parsed = knowledge.fields;
  const normalise = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  const attribute = (value: string | string[] | undefined): string | null => {
    const needles = (Array.isArray(value) ? value : [value])
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map(normalise);
    if (needles.length === 0) return null;
    const page = pages.find((candidate) => {
      const text = normalise(candidate.text);
      return needles.every((needle) => text.includes(needle));
    });
    return page?.url ?? null;
  };
  const now = new Date().toISOString();
  const provenance = {
    kind: "ai_observation" as const,
    sourceId: "crawler-extractor",
    originSystem: "crawlseo",
    // The identifier schema forbids slashes; the full URL stays in evidenceUri.
    originRecordId: createHash("sha256").update(`${site.domain}:${now}`).digest("hex").slice(0, 32),
    originRevision: null,
    actor: { type: "model" as const, id: "crawler-extractor" },
    status: "assumed" as const,
    recordedAt: now,
    observedAt: now,
    evidenceUri: attribute(parsed.businessName) ?? attribute(parsed.location) ?? pages[0].url,
  };
  const fact = (value: string | string[] | undefined, locale?: string) => {
    if (value === undefined) return undefined;
    const clean = Array.isArray(value)
      ? value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 30)
      : String(value).trim();
    if (Array.isArray(clean) ? clean.length === 0 : clean.length === 0) return undefined;
    const source = attribute(value);
    return {
      value: clean,
      // A field is attributed only to a page that actually contains its value.
      // When no page contains it, the source is absent rather than the first page.
      provenance: source ? { ...provenance, evidenceUri: source } : { ...provenance, evidenceUri: null },
      publicationUse: "internal_only" as const,
      ...(locale ? { locale } : {}),
    };
  };

  const changes = Object.fromEntries(
    Object.entries({
      businessName: fact(parsed.businessName),
      services: fact(parsed.services),
      location: fact(parsed.location),
      serviceArea: fact(parsed.serviceArea),
      differentiators: fact(parsed.differentiators),
      audienceMotivations: fact(parsed.audienceMotivations),
      concerns: fact(parsed.concerns),
      conversionGoals: fact(parsed.conversionGoals),
      voice: fact(parsed.voice),
    }).filter(([, value]) => value !== undefined)
  );

  const contentLanguage = knowledge.contentLanguage;

  if (opts.dryRun) {
    return {
      contentLanguage,
      extracted: Object.keys(changes),
      unattributed: Object.keys(changes).filter((field) => !attribute(parsed[field as keyof Extracted])),
      fields: parsed,
      pageUrls: pages.map((page) => page.url),
      documentId: "",
      revision: 0,
      state: "dry-run",
      pagesRead: pages.length,
      pagesFromCrawl: fromCrawl,
      pagesFetched,
      pagesUnreadable,
    };
  }

  const head = await db.businessKnowledgeDocument.findUnique({
    where: { projectId: project.id },
    select: { logicalId: true, revision: true },
  });
  const documentId = head?.logicalId ?? `business-${project.id}`;
  const result = await writeBusinessKnowledge(
    {
      workspaceId: project.workspaceId,
      projectId: project.id,
      documentId,
      expectedRevision: head?.revision ?? 0,
      idempotencyKey: `crawler-extract:${project.id}:${now}`,
      reason: "Extracted from the live site by the crawler extractor; unverified",
      changes,
    },
    {
      credentialId: "internal-extractor",
      servicePrincipalId: "crawler-extractor",
      workspaceId: project.workspaceId,
      projectId: project.id,
      scopes: ["document:write"],
    }
  );

  return {
    contentLanguage,
    extracted: Object.keys(changes),
    // The same page-attribution test the fact writer used: a field with no page
    // that contains it is written with no evidence URI, and reported here.
    unattributed: Object.keys(changes).filter((field) => !attribute(parsed[field as keyof Extracted])),
    fields: parsed,
    pageUrls: pages.map((page) => page.url),
    documentId: result.documentId,
    revision: result.revision,
    state: result.state,
    pagesRead: pages.length,
    pagesFromCrawl: fromCrawl,
    pagesFetched,
    pagesUnreadable,
  };
}

export class BusinessKnowledgeMissingError extends Error {
  constructor(reason: string) {
    super(`BUSINESS_KNOWLEDGE_MISSING: ${reason}`);
    this.name = "BusinessKnowledgeMissingError";
  }
}

export type EnsureBusinessKnowledgeResult = {
  documentId: string;
  revision: number;
  state: "existing" | "extracted";
  extracted: string[];
  contentLanguage: string | null;
};

/**
 * The one gate every analysis path uses: a project either has a usable business
 * knowledge document or gets one from its own pages before anything reads it.
 *
 * It throws rather than returning empty. A research run with no business facts
 * produces findings that could have been written for any site in the market, and
 * the run report used to present that as a completed analysis.
 */
export async function ensureBusinessKnowledge(
  db: ExtractDb,
  opts: { projectId: string; siteId?: string }
): Promise<EnsureBusinessKnowledgeResult> {
  const head = await db.businessKnowledgeDocument.findUnique({
    where: { projectId: opts.projectId },
    select: {
      logicalId: true,
      revision: true,
      revisions: { orderBy: { revision: "desc" }, take: 1, select: { fields: true } },
    },
  });
  if (head && hasUsableKnowledgeFields(head.revisions[0]?.fields)) {
    return { documentId: head.logicalId, revision: head.revision, state: "existing", extracted: [], contentLanguage: null };
  }

  let extracted: ExtractBusinessKnowledgeResult;
  try {
    extracted = await extractBusinessKnowledgeFromSite(db, opts);
  } catch (error) {
    throw new BusinessKnowledgeMissingError(error instanceof Error ? error.message.slice(0, 200) : "extraction failed");
  }
  if (extracted.extracted.length === 0) {
    throw new BusinessKnowledgeMissingError(`no business fact could be extracted from ${extracted.pagesRead} page(s)`);
  }
  return {
    documentId: extracted.documentId,
    revision: extracted.revision,
    state: "extracted",
    extracted: extracted.extracted,
    contentLanguage: extracted.contentLanguage,
  };
}
