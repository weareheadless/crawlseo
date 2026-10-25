export const SEO_TIMEFRAMES = [7, 28, 90, 180] as const;

export type SeoTimeframe = (typeof SEO_TIMEFRAMES)[number];

export function parseSeoTimeframe(value: string | string[] | undefined): SeoTimeframe {
  const raw = Array.isArray(value) ? value[0] : value;
  const days = Number(raw);
  return (SEO_TIMEFRAMES as readonly number[]).includes(days) ? (days as SeoTimeframe) : 28;
}
