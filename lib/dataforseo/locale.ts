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

export type ResolvedDataForSeoLocale = {
  language: string;
  languageCode: string;
  country: string;
  locationCode: number;
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
