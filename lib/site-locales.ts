import { db } from "@/lib/db";

/**
 * One published language of a site. `prefix` is the path segment the locale
 * adds (`/en`), and `query` is the parameter that selects it when the site
 * keeps one route and switches language in the query (`lang=es`).
 */
export type SiteLocale = {
  code: string;
  prefix: string;
  query: string | null;
};

export type SiteLocales = {
  default: string;
  variants: SiteLocale[];
};

export type LocaleVariant = SiteLocale & {
  /** The page path in this locale, without the query. */
  route: string;
  /** The full public URL, including the query when the locale uses one. */
  url: string;
  /** True for the site's default language. */
  isDefault: boolean;
};

const CODE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

function normalizeVariant(value: unknown): SiteLocale | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const code = typeof row.code === "string" ? row.code.trim() : "";
  if (!CODE.test(code)) return null;
  const prefix = typeof row.prefix === "string" ? row.prefix.trim().replace(/\/+$/, "") : "";
  if (prefix && !/^\/[a-z]{2}(?:-[A-Za-z]{2})?$/.test(prefix)) return null;
  const query = typeof row.query === "string" && row.query.trim() ? row.query.trim() : null;
  if (query && !/^[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+$/.test(query)) return null;
  return { code, prefix, query };
}

export function parseSiteLocales(value: unknown): SiteLocales | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const variants = Array.isArray(row.variants)
    ? row.variants.map(normalizeVariant).filter((variant): variant is SiteLocale => Boolean(variant))
    : [];
  if (variants.length === 0) return null;
  const codes = new Set(variants.map((variant) => variant.code));
  if (codes.size !== variants.length) return null;
  const fallback = variants.find((variant) => !variant.prefix && !variant.query)?.code ?? variants[0].code;
  const preferred = typeof row.default === "string" && codes.has(row.default) ? row.default : fallback;
  return { default: preferred, variants };
}

export async function getSiteLocales(siteId: string): Promise<SiteLocales | null> {
  const profile = await db.siteProfile.findUnique({ where: { siteId }, select: { locales: true } });
  return parseSiteLocales(profile?.locales);
}

export async function saveSiteLocales(siteId: string, locales: SiteLocales): Promise<SiteLocales> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } });
  if (!site) throw new Error("Site not found");
  await db.siteProfile.upsert({
    where: { siteId },
    create: { siteId, projectId: site.projectId, language: locales.default, locales: locales as never },
    update: { locales: locales as never },
  });
  return locales;
}

/**
 * The page path and URL for each locale. A locale with a prefix adds it to the
 * base route; a locale with a query keeps the route and selects the language
 * in the URL, which is how the Susi site publishes Spanish.
 */
export function localeVariants(locales: SiteLocales, baseRoute: string, domain: string): LocaleVariant[] {
  const route = baseRoute.startsWith("/") ? baseRoute : `/${baseRoute}`;
  const host = domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return locales.variants.map((variant) => {
    const localizedRoute = `${variant.prefix}${route}`.replace(/\/{2,}/g, "/");
    return {
      ...variant,
      route: localizedRoute,
      url: `https://${host}${localizedRoute}${variant.query ? `?${variant.query}` : ""}`,
      isDefault: variant.code === locales.default,
    };
  });
}

/** The query pair a locale uses, when it selects language in the URL. */
export function localeQuery(variant: SiteLocale): { key: string; value: string } | null {
  if (!variant.query) return null;
  const index = variant.query.indexOf("=");
  if (index <= 0) return null;
  return { key: variant.query.slice(0, index), value: variant.query.slice(index + 1) };
}
