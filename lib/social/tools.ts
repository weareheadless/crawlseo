/**
 * The tools the social editor may use.
 *
 * These are extraction, not judgement: read a page and list what is in it, ask a
 * stock library for photographs, and list the brand's own files. Which picture a
 * post carries is the editor's call, made against what it actually found.
 *
 * No heuristic here decides an image. A rule like "the largest image over 1000px
 * in the page" is exactly the kind of guess this replaces.
 */

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_500_000;
const IMAGE_URL = /https:\/\/[^"'\s<>\\\\)]+?\.(?:jpe?g|png|webp)(?:\/[^"'\s<>\\\\)]*)?/gi;

export type PageImage = { url: string; width: number; alt: string };

export type PageRead = {
  url: string;
  title: string;
  description: string;
  images: PageImage[];
  status: number;
  note?: string;
};

function meta(html: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const found = pattern.exec(html)?.[1]?.trim();
    if (found) return found.replace(/&amp;/g, "&");
  }
  return "";
}

/** Everything a page shows: its headings and the pictures it declares. */
export function readPageFrom(html: string, url: string): Omit<PageRead, "status"> {
  const title = meta(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ]);
  const description = meta(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  ]);

  const altByUrl = new Map<string, string>();
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = /(?:src|data-src)=["']([^"']+)["']/i.exec(tag)?.[1];
    const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1];
    if (src && alt) altByUrl.set(src.replace(/&amp;/g, "&"), alt);
  }

  const seen = new Set<string>();
  const images: PageImage[] = [];
  for (const raw of html.match(IMAGE_URL) ?? []) {
    const imageUrl = raw.replace(/&amp;/g, "&");
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    images.push({
      url: imageUrl,
      width: Number(/[wW]_(\d+)/.exec(imageUrl)?.[1] ?? 0),
      alt: altByUrl.get(imageUrl) ?? "",
    });
  }
  return { url, title, description, images: images.sort((a, b) => b.width - a.width).slice(0, 40) };
}

export async function readPage(url: string, fetchImpl: typeof fetch = fetch): Promise<PageRead> {
  const plain: PageRead = { url, title: "", description: "", images: [], status: 0 };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "text/html", "user-agent": "CiceroSocial/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ...plain, note: `could not fetch: ${(error as Error).message}` };
  }
  if (!response.ok) return { ...plain, status: response.status, note: `answered ${response.status}` };
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return { ...plain, status: response.status, note: `not html: ${type}` };
  const text = (await response.text()).slice(0, MAX_BYTES);
  return { ...readPageFrom(text, url), status: response.status };
}

export type StockPhoto = { url: string; alt: string; credit: string };

/**
 * A stock search, injected: the Unsplash client lives with the delivery code and
 * owns its key and place matching. The editor only sees results.
 */
export type SearchPhotos = (query: string) => Promise<StockPhoto[]>;

/** Every page the site publishes, from its sitemap. */
export async function listSitePages(origin: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const base = origin.replace(/\/+$/, "");
  const read = async (url: string): Promise<string[]> => {
    const response = await fetchImpl(url, {
      headers: { accept: "application/xml,text/xml" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    if (!response || !response.ok) return [];
    const text = (await response.text()).slice(0, MAX_BYTES);
    const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].trim());
    // A sitemap index points at child sitemaps; a page sitemap points at pages.
    return locs.some((loc) => loc.endsWith(".xml")) ? locs : locs.filter((loc) => !loc.endsWith(".xml"));
  };

  const top = await read(`${base}/sitemap.xml`);
  const children = top.filter((loc) => loc.endsWith(".xml"));
  if (children.length === 0) return top;
  const pages: string[] = [];
  for (const child of children.slice(0, 6)) pages.push(...(await read(child)));
  return [...new Set(pages)];
}

export type BrandPhoto = { file: string; description: string };

export type SocialTools = {
  readPage: (url: string) => Promise<PageRead>;
  searchPhotos?: SearchPhotos;
  listSitePages?: () => Promise<string[]>;
  /** The site's own search: which pages mention these words. */
  findPages?: (query: string) => Promise<string[]>;
  brandPhotos: BrandPhoto[];
};

/** Words a page URL is matched by: "Playa del Carmen" → playa, carmen. */
export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !["del", "las", "los", "the", "and", "for", "sale"].includes(token));
}

/** URLs that mention the most of the query's words, best first. */
export function rankPages(query: string, pages: readonly string[], limit = 20): string[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const scored = pages
    .map((page) => {
      const haystack = decodeURIComponent(page).toLowerCase();
      return { page, score: tokens.filter((token) => haystack.includes(token)).length };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((row) => row.page);
}

/** Tool descriptions, as the model sees them. */
type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export function toolDefinitions(options: { stock: boolean }): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "read_page",
        description:
          "Fetch a web page and return its title, description and the images it shows, largest first. Use it on the site's own pages and on sources you are considering.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "absolute https URL" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_site_pages",
        description:
          "Every page and post the site publishes, from its sitemap. Use it to find the page about your subject before you look for a photograph.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "find_page",
        description:
          "Search the site and open the best matches: each result has the page's title, description and the images it shows with alt text and size. Use the place name from your subject. This is how you find a photograph of the subject.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "words to look for, e.g. \"Xcalacoco\"" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_brand_photos",
        description: "The photographs this brand owns, with a description of what is in each.",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  if (options.stock) {
    tools.push({
      type: "function",
      function: {
        name: "search_photos",
        description:
          "Search a stock photograph library. Returns candidates with alt text and the credit the post must carry. Use the place as the query, not the concept.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "what the photograph should show" } },
          required: ["query"],
        },
      },
    });
  }
  return tools;
}

/** Pages grouped by their first path segment, so a long sitemap stays readable. */
export function bySection(pages: readonly string[]): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  for (const page of pages) {
    let key = "(root)";
    try {
      const segments = new URL(page).pathname.split("/").filter(Boolean);
      key = segments.length > 0 ? `/${segments[0]}/` : "(root)";
    } catch {
      key = "(unparsed)";
    }
    (sections[key] ??= []).push(page);
  }
  return sections;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  tools: SocialTools,
): Promise<unknown> {
  if (name === "read_page") {
    const url = String(args.url ?? "");
    if (!/^https:\/\//.test(url)) return { error: "url must be absolute https" };
    return tools.readPage(url);
  }
  if (name === "list_site_pages") {
    if (!tools.listSitePages) return { error: "the site is not configured" };
    const pages = await tools.listSitePages();
    return { count: pages.length, sections: bySection(pages) };
  }
  if (name === "find_page") {
    if (!tools.findPages) return { error: "the site is not configured" };
    const query = String(args.query ?? "");
    const matches = await tools.findPages(query);
    if (matches.length === 0) return { query, count: 0, pages: [] };
    // Searching a site and then having to open the result is two guesses in a
    // row. The search returns the page as well: its title and the images in it.
    const opened = await Promise.all(
      matches.slice(0, 3).map((url) => tools.readPage(url).catch(() => null)),
    );
    return {
      query,
      count: matches.length,
      alsoMentioned: matches.slice(3, 12),
      pages: opened.filter(Boolean).map((page) => ({
        url: page!.url,
        status: page!.status,
        title: page!.title,
        description: page!.description,
        images: page!.images.slice(0, 20),
        note: page!.note,
      })),
    };
  }
  if (name === "list_brand_photos") {
    return { photos: tools.brandPhotos };
  }
  if (name === "search_photos") {
    if (!tools.searchPhotos) return { error: "no stock library is configured" };
    return { photos: await tools.searchPhotos(String(args.query ?? "")).catch((error) => []) };
  }
  return { error: `unknown tool ${name}` };
}
