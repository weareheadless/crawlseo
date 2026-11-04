import type { PrismaClient } from "@prisma/client";

/**
 * The site's own facts, resolved once.
 *
 * Before this module every consumer answered "what language / country / market /
 * location is this site?" for itself, and each answer was a `?? "en"` or a
 * hardcoded list of places. That is why the same bug kept reappearing in a new
 * file every week: asking was optional.
 *
 * Now the question has one answer, computed in one place, with the provenance of
 * each field recorded. A caller that needs a locale takes a `SiteContext`; it
 * cannot invent one.
 */

export type ContextSource =
  | "business_knowledge"
  | "site_profile"
  | "domain_tld"
  | "language"
  | "unknown";

export type SiteContext = {
  siteId: string;
  projectId: string | null;
  domain: string;
  /** BCP-47 primary subtag, lower-case: "fr", "en", "de". */
  language: string;
  /** ISO-3166 alpha-2 upper-case, or null when the site genuinely has no market. */
  country: string | null;
  /** The market as the owner wrote it ("France", "Normandie", "United States"). */
  market: string | null;
  /** A place to name in generated assets: town, region or service area. */
  location: string | null;
  topics: string[];
  audience: string | null;
  source: {
    language: ContextSource;
    country: ContextSource;
    location: ContextSource;
  };
};

export class MissingSiteContextError extends Error {
  readonly siteId: string;
  readonly field: "language";
  constructor(siteId: string, message: string) {
    super(message);
    this.name = "MissingSiteContextError";
    this.siteId = siteId;
    this.field = "language";
  }
}

const TLD_COUNTRY: Record<string, string> = {
  uk: "GB", fr: "FR", de: "DE", es: "ES", it: "IT", pt: "PT", nl: "NL", be: "BE", ch: "CH",
  at: "AT", ca: "CA", mx: "MX", br: "BR", us: "US", co: "US", ie: "IE", au: "AU",
  nz: "NZ", jp: "JP", pl: "PL", se: "SE", dk: "DK", no: "NO", fi: "FI",
};

const TLD_LANGUAGE: Record<string, string> = {
  uk: "en", fr: "fr", de: "de", es: "es", it: "it", pt: "pt", nl: "nl", be: "nl", ch: "de",
  at: "de", ca: "en", mx: "es", br: "pt", us: "en", co: "en", ie: "en", au: "en",
  nz: "en", jp: "ja", pl: "pl", se: "sv", dk: "da", no: "no", fi: "fi",
};

/** Languages that name one market strongly enough to be a country signal. */
const LANGUAGE_COUNTRY: Record<string, string> = {
  fr: "FR", de: "DE", es: "ES", it: "IT", pt: "PT", nl: "NL", ja: "JP", pl: "PL",
  sv: "SE", da: "DK", no: "NO", fi: "FI",
};

const COUNTRY_WORDS: Array<[RegExp, string]> = [
  [/mexi|méxi|mexique/, "MX"],
  [/france|français|francais|french|normandie|bretagne|provence|occitanie/, "FR"],
  [/spain|españa|espagne|spanish|español/, "ES"],
  [/united kingdom|\buk\b|royaume-uni|angleterre|england|scotland|wales/, "GB"],
  [/canada|québec|quebec/, "CA"],
  [/belgi|belgique|belgië/, "BE"],
  [/suisse|switzerland|schweiz/, "CH"],
  [/ital|italia|italie/, "IT"],
  [/german|deutschland|allemagne/, "DE"],
  [/portug|português|portugais/, "PT"],
  [/netherlands|nederland|pays-bas|holland/, "NL"],
  [/united states|\busa\b|\bu\.s\.|\bamerica\b/, "US"],
];

/** Country named by free text, or null. It never guesses. */
export function countryFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const value = text.toLowerCase();
  for (const [pattern, code] of COUNTRY_WORDS) if (pattern.test(value)) return code;
  return null;
}

/** Country and language implied by the registrable domain's TLD, or null. */
export function tldSignals(domain: string | null | undefined): { country: string | null; language: string | null } {
  const host = (domain ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim();
  if (!host || !host.includes(".")) return { country: null, language: null };
  const parts = host.split(".");
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2] ?? "";
  // co.uk, com.au, co.nz: the country is the last label, the registrable part
  // sits one level up.
  const tld = ["co", "com", "org", "net", "ac", "gov"].includes(secondLast) && last.length === 2 ? last : last;
  return { country: TLD_COUNTRY[tld] ?? null, language: TLD_LANGUAGE[tld] ?? null };
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const found = value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (found) return found.trim();
  }
  return null;
}

function factValue(fields: Record<string, unknown>, key: string): unknown {
  const entry = fields[key];
  if (entry && typeof entry === "object" && "value" in (entry as Record<string, unknown>)) {
    return (entry as Record<string, unknown>).value;
  }
  return entry;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

type ContextDb = Pick<PrismaClient, "site" | "siteProfile" | "businessKnowledgeDocument">;

/**
 * Read the owner's accepted business knowledge for a project, falling back to the
 * latest revision. Returns the field map or an empty object.
 */
export async function businessKnowledgeFields(
  db: Pick<PrismaClient, "businessKnowledgeDocument">,
  projectId: string | null | undefined
): Promise<Record<string, unknown>> {
  if (!projectId) return {};
  const document = await db.businessKnowledgeDocument.findUnique({
    where: { projectId },
    select: {
      revision: true,
      acceptedRevision: true,
      revisions: { orderBy: { revision: "desc" }, select: { revision: true, fields: true } },
    },
  });
  if (!document) return {};
  const wanted = document.acceptedRevision ?? document.revision;
  const revision = document.revisions.find((row) => row.revision === wanted) ?? document.revisions[0];
  return (revision?.fields ?? {}) as Record<string, unknown>;
}

export async function resolveSiteContext(db: ContextDb, siteId: string): Promise<SiteContext> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, projectId: true, domain: true },
  });
  if (!site) throw new Error(`Site ${siteId} not found`);

  const [profile, fields] = await Promise.all([
    db.siteProfile.findUnique({
      where: { siteId },
      select: { language: true, topics: true, audience: true, constraints: true },
    }),
    businessKnowledgeFields(db, site.projectId),
  ]);

  const constraints = profile?.constraints && typeof profile.constraints === "object" && !Array.isArray(profile.constraints)
    ? profile.constraints as Record<string, unknown>
    : {};
  const tld = tldSignals(site.domain);

  // Language: the owner's knowledge, then the profile, then the domain. There is
  // no silent "en": a site that says nothing about itself is a configuration
  // error, not an English site.
  let language: string | null = null;
  let languageSource: ContextSource = "unknown";
  const knowledgeLanguage = firstString(factValue(fields, "language"));
  if (knowledgeLanguage) {
    language = knowledgeLanguage.toLowerCase().slice(0, 2);
    languageSource = "business_knowledge";
  } else if (typeof profile?.language === "string" && profile.language.trim()) {
    language = profile.language.trim().toLowerCase().slice(0, 2);
    languageSource = "site_profile";
  } else if (tld.language) {
    language = tld.language;
    languageSource = "domain_tld";
  }
  if (!language) {
    throw new MissingSiteContextError(
      siteId,
      `Site ${site.domain} has no language: set it in the site profile (or business knowledge) before running research.`
    );
  }

  // Market: the owner's words, then the profile's constraints.
  const market = firstString(factValue(fields, "market"))
    ?? (typeof constraints.market === "string" && constraints.market.trim() ? constraints.market.trim() : null);

  // Location: a place to name, not a country code.
  let location = firstString(factValue(fields, "location"));
  let locationSource: ContextSource = location ? "business_knowledge" : "unknown";
  if (!location) {
    const area = firstString(factValue(fields, "serviceArea"));
    if (area) {
      location = area;
      locationSource = "business_knowledge";
    } else if (market) {
      location = market;
      locationSource = "site_profile";
    }
  }

  // Country: explicit market text, then the domain, then an unambiguous language.
  // Null stays null: the DataForSEO catalog decides its own default, once.
  let country = countryFromText(market)
    ?? countryFromText(location)
    ?? countryFromText(firstString(factValue(fields, "serviceArea")));
  let countrySource: ContextSource = country ? "business_knowledge" : "unknown";
  if (!country && tld.country) {
    country = tld.country;
    countrySource = "domain_tld";
  }
  if (!country && LANGUAGE_COUNTRY[language]) {
    country = LANGUAGE_COUNTRY[language];
    countrySource = "language";
  }

  return {
    siteId: site.id,
    projectId: site.projectId,
    domain: site.domain,
    language,
    country,
    market,
    location,
    topics: stringList(profile?.topics),
    audience: typeof profile?.audience === "string" && profile.audience.trim() ? profile.audience.trim() : null,
    source: { language: languageSource, country: countrySource, location: locationSource },
  };
}
