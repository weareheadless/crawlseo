// Customer-facing locale values stay portable; DataForSEO-specific values are
// resolved from its current, source-specific catalog before paid work.
export const DATAFORSEO_LOCATION_CODES: Readonly<Record<string, number>> = {
  AT: 2040,
  AU: 2036,
  BE: 2056,
  BR: 2076,
  CA: 2124,
  CH: 2756,
  DE: 2276,
  DK: 2208,
  ES: 2724,
  FI: 2246,
  FR: 2250,
  GB: 2826,
  IE: 2372,
  IN: 2356,
  IT: 2380,
  JP: 2392,
  MX: 2484,
  NL: 2528,
  NO: 2578,
  NZ: 2554,
  PT: 2620,
  SE: 2752,
  SG: 2702,
  US: 2840,
  ZA: 2710,
};

const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

export class DataForSeoLocaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataForSeoLocaleError";
  }
}

export type DataForSeoLocaleCatalogEntry = {
  country: string;
  languageCode: string;
  locationCode: number;
};

/**
 * What a locale had to give up to be usable.
 *
 * DataForSEO does not offer every language in every country — there is no English
 * keyword data for Mexico, only Spanish. Refusing to resolve then dropped the
 * whole paid evidence class for an English-language site selling into that market,
 * silently, because the caller caught the error and continued without it.
 */
export type LocaleFallback = {
  axis: "language" | "country";
  requested: string;
  used: string;
  reason: string;
};

export type ResolvedDataForSeoLocale = {
  language: string;
  languageCode: string;
  country: string;
  locationCode: number;
  fallback?: LocaleFallback;
};

/** The language a country's own searches are overwhelmingly written in. */
const COUNTRY_LANGUAGE: Readonly<Record<string, string>> = {
  MX: "es", ES: "es", AR: "es", CO: "es", CL: "es", PE: "es",
  FR: "fr", BE: "nl", CH: "de", CA: "en", US: "en", GB: "en", AU: "en", IE: "en", NZ: "en",
  DE: "de", AT: "de", IT: "it", PT: "pt", BR: "pt", NL: "nl", JP: "ja",
  SE: "sv", DK: "da", NO: "no", FI: "fi", PL: "pl", IN: "en", SG: "en", ZA: "en",
};

/** Where a language is searched most when the market itself is unknown. */
const LANGUAGE_COUNTRY: Readonly<Record<string, string>> = {
  en: "US", es: "ES", fr: "FR", de: "DE", it: "IT", pt: "PT", nl: "NL", ja: "JP",
  sv: "SE", da: "DK", no: "NO", fi: "FI", pl: "PL",
};

export function normalizeDataForSeoLanguage(value: unknown, field = "language"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DataForSeoLocaleError(`${field} must be an ISO language code`);
  }
  const normalized = value.trim().toLowerCase();
  if (!LANGUAGE_PATTERN.test(normalized)) {
    throw new DataForSeoLocaleError(`${field} must be an ISO language code`);
  }
  return normalized;
}

export function normalizeDataForSeoCountry(value: unknown, field = "country"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DataForSeoLocaleError(`${field} must be an ISO country code`);
  }
  const normalized = value.trim().toUpperCase();
  if (!COUNTRY_PATTERN.test(normalized)) {
    throw new DataForSeoLocaleError(`${field} must be an ISO country code`);
  }
  return normalized;
}

export function resolveDataForSeoLocaleFromCatalog(
  catalog: readonly DataForSeoLocaleCatalogEntry[],
  languageValue: unknown,
  countryValue: unknown
): ResolvedDataForSeoLocale {
  const language = normalizeDataForSeoLanguage(languageValue);
  const country = normalizeDataForSeoCountry(countryValue);
  const languageCode = language.split("-", 1)[0];
  const countryEntries = catalog.filter((entry) => entry.country === country);
  if (!countryEntries.length) {
    throw new DataForSeoLocaleError(
      `DataForSEO does not support Google keyword research for country ${country}`
    );
  }

  const match = countryEntries.find(
    (entry) => entry.languageCode.toLowerCase().split("-", 1)[0] === languageCode
  );
  if (!match) {
    const available = [...new Set(countryEntries.map((entry) => entry.languageCode))].sort();
    throw new DataForSeoLocaleError(
      `DataForSEO does not support language ${language} for Google keyword research in ${country}; `
      + `available languages: ${available.join(", ") || "none"}`
    );
  }

  return {
    language,
    languageCode: match.languageCode,
    country,
    locationCode: match.locationCode,
  };
}

/**
 * Resolve a locale, giving up one axis rather than giving up the work.
 *
 * Order of preference:
 *  1. the exact pair the site asked for;
 *  2. the same market in the language that market actually searches in (an
 *     English-language site selling into Mexico is measured in Spanish);
 *  3. the same language in the market where that language is searched most.
 *
 * Whatever is given up is returned in `fallback`, so the run can record that it
 * measured a proxy rather than pretend the pair existed.
 */
export function resolveDataForSeoLocaleWithFallback(
  catalog: readonly DataForSeoLocaleCatalogEntry[],
  languageValue: unknown,
  countryValue: unknown
): ResolvedDataForSeoLocale {
  const language = normalizeDataForSeoLanguage(languageValue);
  const country = normalizeDataForSeoCountry(countryValue);
  const languageCode = language.split("-", 1)[0];

  const countryEntries = catalog.filter((entry) => entry.country === country);
  if (countryEntries.length > 0) {
    const exact = countryEntries.find(
      (entry) => entry.languageCode.toLowerCase().split("-", 1)[0] === languageCode
    );
    if (exact) {
      return { language, languageCode: exact.languageCode, country, locationCode: exact.locationCode };
    }
    const preferred = countryEntries.find(
      (entry) => entry.languageCode.toLowerCase().split("-", 1)[0] === COUNTRY_LANGUAGE[country]
    ) ?? countryEntries[0];
    const available = [...new Set(countryEntries.map((entry) => entry.languageCode))].sort();
    return {
      language: preferred.languageCode,
      languageCode: preferred.languageCode,
      country,
      locationCode: preferred.locationCode,
      fallback: {
        axis: "language",
        requested: `${language}/${country}`,
        used: `${preferred.languageCode}/${country}`,
        reason: `DataForSEO has no ${language} keyword data for ${country}; available: ${available.join(", ") || "none"}`,
      },
    };
  }

  const alternativeCountry = LANGUAGE_COUNTRY[languageCode];
  const alternative = alternativeCountry
    ? catalog.find((entry) => entry.country === alternativeCountry && entry.languageCode.toLowerCase().split("-", 1)[0] === languageCode)
    : undefined;
  if (alternative) {
    return {
      language,
      languageCode: alternative.languageCode,
      country: alternative.country,
      locationCode: alternative.locationCode,
      fallback: {
        axis: "country",
        requested: `${language}/${country}`,
        used: `${alternative.languageCode}/${alternative.country}`,
        reason: `DataForSEO does not cover ${country}; measured in ${alternative.country}`,
      },
    };
  }

  throw new DataForSeoLocaleError(
    `DataForSEO supports neither ${country} nor ${language} as a keyword-research locale`
  );
}
