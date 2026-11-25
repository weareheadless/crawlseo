import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { writeBusinessKnowledge } from "@/lib/projects/business-knowledge";
import {
  PAGE_SELECTION_BOUNDS,
  readCrawledPages,
  selectPagesForExtraction,
} from "@/lib/projects/knowledge-page-selection";
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
  /**
   * Who the business sells to, and in what language.
   *
   * These were missing entirely, and they are the fields the site-context
   * resolver reads to decide which market to measure in. Without them a document
   * could be extracted perfectly and still leave the pipeline unable to plan a
   * bundle — measured 2026-11-25: atelier and susimacdonald only had an audience
   * market because somebody typed it into the site profile, and the three
   * tenants without one could never buy any paid evidence at all.
   *
   * `market` is where the business is (already implied by `location`, stated
   * explicitly when the site does); `audienceMarket` is where its buyers are,
   * which is a different question and often a different country.
   */
  market?: string;
  audienceMarket?: string;
  audienceMarkets?: string[];
  audienceLanguages?: string[];
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
conversionGoals (list), voice (text), market (text), audienceMarket (text),
audienceMarkets (list), audienceLanguages (list).
Rules: invent nothing. If a fact does not appear explicitly on the pages, omit the key.
Values must be short, factual, in the language of the site content, and quoted verbatim when they are a name.
Always return a JSON object. Return {} when the pages contain no extractable business fact.

market is the country or region the business operates in, named as the site names it. location is the town or city.
audienceMarket is where the business's customers are, when the site says so and it differs from market: a school in Mexico teaching students who fly in from the United States has market Mexico and audienceMarket United States. Only state a country the pages name, or the country a named town unambiguously sits in when the pages also name it elsewhere.
audienceMarkets is that as a list when several are named. audienceLanguages is the ISO 639-1 codes the site publishes in, only when it publishes in more than one.
The country matters more than any other field: without it nothing downstream can be measured. Look for it in about, contact, legal, shipping and footer text as well as the homepage.`;

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
  /** Pages the extractor read, with their retrieved text. */
  pageUrls: string[];
  /**
   * Crawled pages that were not sent, and why.
   *
   * A selection is not a truncation, but a selection nobody counts is: the
   * extractor used to read 10 of 483 pages with no record of the other 473.
   */
  skipped: { pages: number; reason: string };
  documentId: string;
  revision: number;
  state: string;
  pagesRead: number;
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

/**
 * Read the site's own pages and write a working business-knowledge revision.
 *
 * Pages come from traffic evidence first, then one representative per top-level
 * sitemap section, then the root. Traffic pages alone miss service sections that
 * rarely rank — a service offered on its own page was absent from an earlier
 * extraction for exactly that reason.
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

  // Read what the crawl already stored, not ten URLs re-fetched over HTTP.
  //
  // The HTTP path had three faults that composed into one: it read at most ten
  // pages of a 483-page site, two of the three country-less tenants return 404 on
  // /sitemap.xml so the section list was empty and the selection collapsed to the
  // homepage, and the word that would have named the country sat unread on /about.
  // The crawl has the text of every page; this reads it.
  const crawled = await readCrawledPages(db, site.id);
  if (!crawled || crawled.pages.length === 0) {
    throw new Error("no completed crawl with stored page text: run a crawl before extracting business knowledge");
  }
  const selection = selectPagesForExtraction(crawled.pages, PAGE_SELECTION_BOUNDS);
  if (selection.selected.length === 0) {
    throw new Error(`the crawl stored no usable page text (${selection.skipped.reason})`);
  }
  const pages = selection.selected.map((page) => ({ url: page.url, text: page.text, title: page.title ?? page.path }));
  const skipped = selection.skipped;

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
      // The fields the site-context resolver reads to choose a market. Without
      // them the document can be complete and the bundle still cannot plan.
      market: fact(parsed.market),
      audienceMarket: fact(parsed.audienceMarket),
      audienceMarkets: fact(parsed.audienceMarkets),
      audienceLanguages: fact(parsed.audienceLanguages),
    }).filter(([, value]) => value !== undefined)
  );

  const contentLanguage = knowledge.contentLanguage;

  if (opts.dryRun) {
    return {
      contentLanguage,
      extracted: Object.keys(changes),
      fields: parsed,
      pageUrls: pages.map((page) => page.url),
      skipped,
      documentId: "",
      revision: 0,
      state: "dry-run",
      pagesRead: pages.length,
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
    fields: parsed,
    pageUrls: pages.map((page) => page.url),
    skipped,
    documentId: result.documentId,
    revision: result.revision,
    state: result.state,
    pagesRead: pages.length,
  };
}
