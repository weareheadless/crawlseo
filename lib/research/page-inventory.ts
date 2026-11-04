/**
 * Which pages of a site the synthesizer is shown.
 *
 * The synthesizer used to receive the 30 highest `contentScore` pages. Content
 * score measures how substantive a page is, and a template-driven detail page is
 * always more substantive than the hub that links to it. On one tenant, 238
 * property pages tied at 100 and the 13 city pages sat at rank 424 and below, so
 * the model was shown 30 development pages and reported "the site has no
 * city-level entry point" — a claim about the site made from a sample that could
 * never have contained one.
 *
 * Sampling is therefore by page type, not by score: every type the crawl found is
 * represented before any type gets a second page.
 */

/** Locale prefixes a site may use as a first path segment (`/es/property/...`). */
const LOCALE_PREFIXES = new Set([
  "en", "es", "fr", "de", "it", "pt", "nl", "ja", "zh", "ru", "ar",
  "sv", "pl", "tr", "ko", "da", "fi", "no", "cs", "el", "he", "hi", "id", "th", "vi",
]);

/**
 * The page type a URL belongs to: its first path segment, ignoring a locale
 * prefix, so `/es/property/villa` and `/property/villa` are the same type.
 */
export function pageTypeOf(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "other";
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "home";
  const [first, ...rest] = segments;
  if (rest.length === 0) return LOCALE_PREFIXES.has(first.toLowerCase()) ? "home" : first.toLowerCase();
  if (/^[a-z]{2}$/i.test(first) && LOCALE_PREFIXES.has(first.toLowerCase())) return rest[0].toLowerCase();
  return first.toLowerCase();
}

/**
 * Types that carry no market content. They are still listed — a site with no
 * pricing page is worth knowing — but they take a slot only after every content
 * type has one.
 */
const UTILITY_TYPES = new Set([
  "login", "sign-up", "signup", "signin", "sign-in", "register", "account", "cart",
  "checkout", "basket", "search", "privacy-notice", "privacy-policy", "privacy",
  "terms-and-conditions-of-use", "terms", "terms-of-service", "transparency-cookie-policy",
  "cookie-policy", "cookies", "legal", "api", "404", "sitemap", "feed", "rss", "admin",
]);

export function isUtilityType(type: string): boolean {
  return UTILITY_TYPES.has(type);
}

export type PageTypeGroup = {
  type: string;
  /** How many pages of this type the crawl found. */
  pages: number;
  /** The URLs shown to the synthesizer for this type. */
  samples: string[];
};

export type PageInventory = {
  groups: PageTypeGroup[];
  /** The URLs to show the synthesizer, breadth first. */
  sampled: string[];
  /** Pages the crawl found, before sampling. */
  total: number;
};

/**
 * Build the sample the synthesizer sees: one page per type first, then a second
 * and third as the limit allows.
 */
export function buildPageInventory(
  pages: Array<{ url: string; contentScore?: number | null }>,
  limit = 30
): PageInventory {
  const byType = new Map<string, Array<{ url: string; score: number }>>();
  for (const page of pages) {
    const type = pageTypeOf(page.url);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push({ url: page.url, score: page.contentScore ?? 0 });
  }

  // Best page of each type first, so a type's representative is its strongest page.
  for (const list of byType.values()) list.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

  // Larger types first only breaks ties between types of the same size; it must not
  // let a 238-page type crowd out a 6-page one, which the round-robin below prevents.
  const ordered = [...byType.entries()]
    .map(([type, list]) => ({ type, list }))
    .sort((a, b) => b.list.length - a.list.length || b.list[0].score - a.list[0].score || a.type.localeCompare(b.type));

  const samples = new Map<string, string[]>(ordered.map(({ type }) => [type, []]));
  const sampled: string[] = [];
  // Content types first: a login page should never displace a city page.
  for (const tier of [false, true]) {
    const groups = ordered.filter(({ type }) => isUtilityType(type) === tier);
    for (let round = 0; sampled.length < limit; round += 1) {
      let added = false;
      for (const { type, list } of groups) {
        if (round >= list.length) continue;
        samples.get(type)!.push(list[round].url);
        sampled.push(list[round].url);
        added = true;
        if (sampled.length >= limit) break;
      }
      if (!added) break;
    }
    if (sampled.length >= limit) break;
  }

  return {
    groups: ordered.map(({ type, list }) => ({
      type,
      pages: list.length,
      samples: samples.get(type) ?? [],
    })),
    sampled,
    total: pages.length,
  };
}
