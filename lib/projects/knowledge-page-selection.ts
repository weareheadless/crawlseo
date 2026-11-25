import type { PrismaClient } from "@prisma/client";

/**
 * Which of a site's own pages carry its business facts.
 *
 * The extractor used to re-fetch ten URLs over HTTP: the homepage, the
 * best-ranked Search Console pages, and one page per top-level sitemap section.
 * Three things were wrong with that, and they composed into the same failure:
 *
 *  - The crawl has already read and stored the text of every page
 *    (`AuditPage.contentText`). Measured 2026-11-25: casamigo had 483 pages and
 *    1.5M words stored, and the extractor read 10 of them.
 *  - Two of the three tenants with no country return 404 on /sitemap.xml, so the
 *    section list was empty and the selection collapsed to the homepage plus
 *    whatever Search Console had. inmersion read **one page**.
 *  - The one fact that was missing — the country — was on `/about`, which was
 *    never fetched, while the homepage only said "Playa del Carmen", which is
 *    correctly not a country.
 *
 * So this selects from what the crawl already stored, by what a page is for
 * rather than by ranking: the homepage, the contact and about pages, every
 * service-like section, and one page per locale. It is bounded, and it reports
 * what it left out: a subset of a site is fine, a subset nobody counted is not.
 *
 * This is a selection, not a truncation: it chooses pages that carry commercial
 * facts over pages that do not, and says how many it skipped.
 */

export type CrawlPageCandidate = {
  url: string;
  path: string;
  title: string | null;
  wordCount: number;
  contentText: string | null;
};

export type PageSelection = {
  selected: Array<{ url: string; path: string; title: string | null; text: string }>;
  /** Pages with usable text that were not sent, and why. */
  skipped: { pages: number; reason: string };
  /** Locales the site publishes, from the paths that carry a prefix. */
  locales: string[];
};

export const PAGE_SELECTION_BOUNDS = {
  /** Pages sent to the extraction call. Enough for one per section per locale. */
  maxPages: 24,
  /** Characters per page. Long legal or listing pages are cut, not dropped. */
  maxCharsPerPage: 6_000,
  /** Total characters across all pages: the real bound on the model call. */
  maxTotalChars: 90_000,
  /** A page below this is a stub with no facts in it. */
  minWords: 40,
} as const;

/**
 * Path segments that name a page's commercial purpose in any language.
 *
 * Deliberately not a list of English words only: it matches on position and on
 * a handful of stems that appear across languages. It is a *ranking signal* for
 * which pages to read, never a decision about what a page means — nothing here
 * classifies a business, it only orders a reading list.
 */
const SERVICE_STEMS = [
  "service", "servicio", "servicos", "servico", "prestacion",
  "about", "acerca", "sobre", "quienes", "nous", "uber", "nosotros",
  "contact", "contacto", "contacte", "kontakt",
  "price", "prices", "pricing", "precio", "precios", "tarif", "tarifa", "prix",
  "course", "courses", "curso", "cursos", "cours", "formation", "formations", "training",
  "product", "products", "producto", "productos", "produit", "produits",
  "shop", "store", "tienda", "boutique", "collection",
  "team", "equipo", "equipe",
  "faq", "help", "ayuda", "aide",
];

const LOCALE_PATTERN = /^\/([a-z]{2})(?:\/|$)/i;

function segmentsOf(pathValue: string): string[] {
  return pathValue.split("/").filter(Boolean);
}

/** How much a page looks like it states the business's offer. Higher is better. */
function offerScore(page: CrawlPageCandidate, localeCount: number): number {
  const parts = segmentsOf(page.path);
  if (parts.length === 0) return 100; // the homepage always goes
  // A page deep in a catalogue repeats one product; a section page states the
  // offer. Shallower is more informative.
  const depth = parts.length;
  const last = (parts[parts.length - 1] ?? "").toLowerCase();
  const matches = SERVICE_STEMS.some((stem) => last.includes(stem) || parts.some((part) => part.toLowerCase().includes(stem)));
  // A locale root ("/es", "/fr") is a homepage in that language: it carries the
  // offer and, for a multilingual site, the country in its own language.
  if (depth === 1 && LOCALE_PATTERN.test(page.path) && localeCount > 1) return 95;
  return (matches ? 60 : 20) - depth * 2 + Math.min(10, page.wordCount / 200);
}

/**
 * Select the pages worth reading from what the crawl stored.
 *
 * Order is: the homepage, then each locale root, then the highest offer score,
 * then the longest pages as filler. The bound is on pages *and* total
 * characters, because a site of 483 pages can otherwise spend an unbounded
 * amount on one extraction.
 */
export function selectPagesForExtraction(
  pages: CrawlPageCandidate[],
  bounds: { maxPages?: number; maxTotalChars?: number; maxCharsPerPage?: number; minWords?: number } = {}
): PageSelection {
  const maxPages = bounds.maxPages ?? PAGE_SELECTION_BOUNDS.maxPages;
  const maxTotalChars = bounds.maxTotalChars ?? PAGE_SELECTION_BOUNDS.maxTotalChars;
  const maxCharsPerPage = bounds.maxCharsPerPage ?? PAGE_SELECTION_BOUNDS.maxCharsPerPage;
  const minWords = bounds.minWords ?? PAGE_SELECTION_BOUNDS.minWords;

  const withText = pages.filter((page) => (page.contentText ?? "").trim().length > 0);
  const usable = withText.filter((page) => page.wordCount >= minWords);
  const locales = [...new Set(
    pages
      .map((page) => LOCALE_PATTERN.exec(page.path)?.[1]?.toLowerCase() ?? null)
      .filter((code): code is string => code != null)
  )].sort();

  const ranked = [...usable].sort((a, b) => {
    const score = offerScore(b, locales.length) - offerScore(a, locales.length);
    if (score !== 0) return score;
    // Then the longest page: more text means more chance the facts are in it.
    if (b.wordCount !== a.wordCount) return b.wordCount - a.wordCount;
    return a.path.localeCompare(b.path);
  });

  const selected: PageSelection["selected"] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  let stoppedAtChars = false;

  for (const page of ranked) {
    if (selected.length >= maxPages) break;
    if (seen.has(page.path)) continue;
    const text = (page.contentText ?? "").slice(0, maxCharsPerPage);
    if (totalChars + text.length > maxTotalChars) {
      stoppedAtChars = true;
      continue;
    }
    seen.add(page.path);
    totalChars += text.length;
    selected.push({ url: page.url, path: page.path, title: page.title, text });
  }

  const skippedPages = withText.length - selected.length;
  const stubs = withText.length - usable.length;
  const reason = [
    skippedPages > 0 ? `${skippedPages} crawled page(s) were not sent` : null,
    stubs > 0 ? `${stubs} had fewer than ${minWords} words` : null,
    stoppedAtChars ? `the ${maxTotalChars}-character bound was reached` : null,
    withText.length === 0 ? "the crawl stored no page text" : null,
  ]
    .filter(Boolean)
    .join("; ");

  return { selected, skipped: { pages: skippedPages, reason }, locales };
}

/**
 * Read the crawl's stored pages for a site.
 *
 * One crawl, the latest completed one: text from an older crawl describes a site
 * that may no longer exist, and mixing two crawls would attribute a fact to a
 * page whose current content does not contain it.
 */
export async function readCrawledPages(
  db: Pick<PrismaClient, "crawl" | "auditPage">,
  siteId: string
): Promise<{ crawlId: string; pages: CrawlPageCandidate[] } | null> {
  const crawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  if (!crawl) return null;
  const rows = await db.auditPage.findMany({
    where: { crawlId: crawl.id, statusCode: 200, indexable: true },
    select: { url: true, title: true, wordCount: true, contentText: true },
    orderBy: { url: "asc" },
  });
  const pages = rows.flatMap((row) => {
    let pathValue: string;
    try {
      pathValue = new URL(row.url).pathname.replace(/\/+$/, "") || "/";
    } catch {
      return [];
    }
    return [{ url: row.url, path: pathValue, title: row.title, wordCount: row.wordCount, contentText: row.contentText }];
  });
  return { crawlId: crawl.id, pages };
}
