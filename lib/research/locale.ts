/**
 * Resolve the Google News country edition from the configured market/language.
 * The previous runner treated every non-Mexico market as US, which sent French
 * research to the US edition. Language is the safe fallback when market text is
 * missing.
 */
export function researchCountry(market: string | null | undefined, language: string | null | undefined): string {
  const value = `${market ?? ""} ${language ?? ""}`.toLowerCase();
  if (/mexico|méxico|mexique/.test(value)) return "MX";
  if (/france|français|francais|french|normandie|\bfr\b/.test(value)) return "FR";
  if (/spain|españa|espagne|spanish|español/.test(value)) return "ES";
  if (/united kingdom|\buk\b|royaume-uni|angleterre|english/.test(value)) return "GB";
  if (/canada|québec|quebec/.test(value)) return "CA";
  if (/belgium|belgique|belgië/.test(value)) return "BE";
  if (/switzerland|suisse|schweiz/.test(value)) return "CH";
  if (/italy|italia|italie|italian|italiano/.test(value)) return "IT";
  if (/germany|deutschland|allemagne|german|deutsch/.test(value)) return "DE";
  if (/portugal|português|portugais/.test(value)) return "PT";
  return "US";
}
