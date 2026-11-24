/**
 * Which SERP results may be attributed to a real ranking page.
 *
 * Google's SERP payload contains items that are not a competitor's page: redirect
 * wrappers (`google.com/goto?url=…`, `google.com/searchviewer/…`), internal
 * viewer hosts, and cached copies. Storing one as a ranking result makes every
 * downstream number wrong in a way that looks like data: our position never
 * matches, so a site that ranks first is recorded as absent.
 *
 * One rule for "is this a real result", used by the research providers and by the
 * snapshot collector. It is deliberately a pure predicate on the URL: no tenant,
 * no domain, no market.
 */

/** Hostname of a URL, without `www.`, lowercased. Empty string when unparseable. */
export function attributableHost(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when a SERP item's URL can stand for someone's actual ranking page.
 *
 * `domain` is the item's declared domain, used only as a fallback when the URL
 * itself does not parse. It is never trusted over the URL's own host: a wrapper
 * carries `domain: "google.com"` and must be rejected even if a caller passes
 * something else.
 */
export function isAttributableResult(url: string | null | undefined, domain?: string | null): boolean {
  const hostname = attributableHost(url) || (domain ?? "").replace(/^www\./, "").toLowerCase();
  if (hostname === "") return false;
  if (/^(www\.)?google\./.test(hostname)) return false;
  if (hostname.includes("googleusercontent")) return false;
  return true;
}

/**
 * Normalize a configured site domain so it can be compared with a result host.
 * Accepts a bare domain, a `www.` variant, or a URL, and returns the bare host.
 */
export function normalizeSiteDomain(domain: string | null | undefined): string {
  const raw = (domain ?? "").trim();
  if (raw === "") return "";
  const fromUrl = attributableHost(raw);
  if (fromUrl !== "") return fromUrl;
  return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
}

/**
 * Does a SERP result belong to the configured site?
 *
 * Compares hosts, not substrings: `includes(domain)` matches
 * `notexample.com.attacker.test` and misses `example.com` inside a wrapper. A
 * subdomain of the site (`shop.example.com`) counts as the site, because a site's
 * own rankings are not limited to its apex host.
 */
export function isSiteResult(url: string | null | undefined, siteDomain: string): boolean {
  const hostname = attributableHost(url);
  const site = normalizeSiteDomain(siteDomain);
  if (hostname === "" || site === "") return false;
  return hostname === site || hostname.endsWith(`.${site}`);
}

export type ResolvedResult = { url: string | null; domain: string };

/**
 * Recover the real ranking identity behind a SERP item.
 *
 * Verified against live provider output on 2026-11-24: every organic item came
 * back with `url: "https://google.com/goto?url=CAES…"` and
 * `domain: "google.com"` — the wrapper target is an opaque token, not a URL, so it
 * cannot be decoded. Rejecting those items discards the entire SERP.
 *
 * The provider supplies the real identity in the same item:
 *   breadcrumb:    "https://www.harmonies-studio.fr › tarifs"
 *   website_name:  "harmonies-studio.fr"
 *
 * The **domain** is the fact that matters ("who ranks"), and it is recoverable
 * reliably. The exact URL is not: breadcrumbs truncate paths as
 * `"https://www.facebook.com › ... › L'Atelier des Harmonies"`, so a rebuilt URL
 * containing `...` would be a plausible-looking page that does not exist. When the
 * path is truncated the domain is kept and `url` is `null` — never invented.
 */
export function resolveRankedResult(item: {
  url?: string | null;
  domain?: string | null;
  breadcrumb?: string | null;
}): ResolvedResult | null {
  // Already a real page: keep its URL and host. A non-empty URL is required here,
  // otherwise an empty string would pass on the declared domain alone and we would
  // report a page we never saw.
  if (item.url && isAttributableResult(item.url, item.domain)) {
    const host = attributableHost(item.url);
    if (host !== "") return { url: String(item.url), domain: host };
  }

  const fromBreadcrumb = resolveBreadcrumb(item.breadcrumb);
  if (fromBreadcrumb) return fromBreadcrumb;

  // Last resort: the declared domain, when it is a real host rather than Google.
  const declared = normalizeSiteDomain(item.domain);
  if (declared !== "" && isAttributableResult(`https://${declared}/`, declared)) {
    return { url: `https://${declared}/`, domain: declared };
  }
  return null;
}

/**
 * A breadcrumb is `host › path › path`. The first segment is the real site; the
 * rest is the path *when it is complete*. A `...` / `…` segment means the provider
 * truncated it, so the host is kept and the path is not reconstructed.
 */
function resolveBreadcrumb(breadcrumb: string | null | undefined): ResolvedResult | null {
  const raw = (breadcrumb ?? "").trim();
  if (raw === "" || !raw.includes("›")) return null;
  const segments = raw.split("›").map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  const head = segments[0];
  const host = attributableHost(head) || normalizeSiteDomain(head);
  if (host === "" || !isAttributableResult(`https://${host}/`, host)) return null;

  const rest = segments.slice(1);
  const truncated = rest.some((part) => /^(\.{3}|…)$/.test(part) || part.includes("...") || part.includes("…"));
  if (truncated || rest.length === 0) {
    return { url: truncated ? null : `https://${host}/`, domain: host };
  }

  const path = rest.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return { url: path === "" ? `https://${host}/` : `https://${host}/${path}`, domain: host };
}

/**
 * Compare two bare hosts for "same site". A subdomain belongs to its parent
 * (`shop.example.com` is `example.com`), but a lookalike does not
 * (`notexample.com` is not `example.com`).
 */
export function sameSite(hostA: string, hostB: string): boolean {
  const a = normalizeSiteDomain(hostA);
  const b = normalizeSiteDomain(hostB);
  if (a === "" || b === "") return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
