/**
 * Where the photograph comes from.
 *
 * A post about a place should show that place. In order of preference:
 *
 * 1. The site's own page about the subject — its share image is the real thing.
 * 2. A stock photograph found by the subject, when the site has no page for it.
 * 3. One of the brand's own photos, chosen by its description.
 *
 * Never a file name picked blind: the first two are tied to the subject by the
 * page it came from or the query that found it.
 */

export type ResolvedImage =
  | { source: "page"; url: string; alt: string; credit: string; pageUrl: string }
  | { source: "unsplash"; url: string; alt: string; credit: string; query: string }
  | { source: "none"; reason: string };

const TIMEOUT_MS = 15_000;
const MAX_HTML = 512 * 1024;

/** The tokens a subject is matched by in a URL: "Playa del Carmen" → playa, carmen. */
export function subjectTokens(subject: string): string[] {
  return subject
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !["del", "las", "los", "the", "and"].includes(token));
}

/** Pages about the subject, not merely in the same place. */
export function pagesAbout(subject: string, pages: readonly string[]): string[] {
  const tokens = subjectTokens(subject);
  if (tokens.length === 0) return [];
  return pages.filter((page) => {
    const haystack = page.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

const IMAGE_URL = /https:\/\/[^"'\s<>\\)]+?\.(?:jpe?g|png|webp)(?:\/[^"'\s<>\\)]*)?/gi;

/**
 * A photograph in the page, not the site's share card.
 *
 * Wix (and most builders) put a site-wide logo image in `og:image`, so the share
 * image is not evidence of a photograph. A body image is: it carries a real
 * width and a file name that is not a logo.
 */
export function photoFrom(html: string, excludeAssets: readonly string[] = []): { url: string; alt: string } | null {
  const candidates = html.match(IMAGE_URL) ?? [];
  let best: { url: string; width: number } | null = null;
  for (const raw of candidates) {
    const url = raw.replace(/&amp;/g, "&");
    if (/logo|wordmark|icon|avatar|favicon|placeholder|sprite/i.test(url)) continue;
    // The site's share card is the same asset on every page, and is usually the
    // logo. It is never the photograph the post needs.
    if (excludeAssets.some((id) => id && url.includes(id))) continue;
    const width = Number(/[wW]_(\d+)/.exec(url)?.[1] ?? 0);
    // No declared size means no way to know it is not a thumbnail.
    if (width < 1000) continue;
    if (!best || width > best.width) best = { url, width };
  }
  return best ? { url: best.url, alt: "" } : null;
}

/** A page's own share image, if it declares one. */
export function shareImageFrom(html: string, baseUrl: string): { url: string; alt: string } | null {
  const pick = (pattern: RegExp) => pattern.exec(html)?.[1]?.trim() ?? "";
  const url =
    pick(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (!url) return null;
  const alt =
    pick(/<meta[^>]+property=["']og:image:alt["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    "";
  try {
    return { url: new URL(url, baseUrl).toString(), alt };
  } catch {
    return null;
  }
}

async function pageImage(
  pageUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ url: string; alt: string } | null> {
  let response: Response;
  try {
    response = await fetchImpl(pageUrl, {
      headers: { accept: "text/html", "user-agent": "CiceroSocial/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return null;
  const text = (await response.text()).slice(0, MAX_HTML);
  const share = shareImageFrom(text, pageUrl);
  // Never the share card itself: it is the site's logo on most builders. Only a
  // photograph from the page counts.
  return photoFrom(text, share ? [assetId(share.url)] : []);
}

/** The media id inside a builder's image URL. */
export function assetId(url: string): string {
  const match = /\/media\/([^/~?]+)/.exec(url);
  return match ? match[1] : "";
}

export type ResolveImageOptions = {
  subject: string;
  /** URLs the crawl knows about. */
  pages: readonly string[];
  /** Injected so a test never touches the network. */
  fetchImpl?: typeof fetch;
  /** Unsplash lookup, injected by the caller that owns the key. */
  findStock?: (query: string) => Promise<{ url: string; alt: string; credit: string } | null>;
};

export async function resolveImage(options: ResolveImageOptions): Promise<ResolvedImage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const matches = pagesAbout(options.subject, options.pages);
  for (const pageUrl of matches.slice(0, 2)) {
    const share = await pageImage(pageUrl, fetchImpl);
    if (share) {
      return {
        source: "page",
        url: share.url,
        alt: share.alt || options.subject,
        credit: "",
        pageUrl,
      };
    }
  }

  if (options.findStock) {
    const stock = await options.findStock(options.subject).catch(() => null);
    if (stock) {
      return { source: "unsplash", url: stock.url, alt: stock.alt, credit: stock.credit, query: options.subject };
    }
  }

  return {
    source: "none",
    reason: matches.length === 0
      ? `no page on the site is about ${options.subject}`
      : `the pages about ${options.subject} declare no share image`,
  };
}
