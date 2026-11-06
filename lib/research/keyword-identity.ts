/**
 * Keyword identity.
 *
 * DataForSEO reports 1,300 for "freediving course" and 1,300 for "freediving
 * courses" - the same demand, not two thousand six hundred. Summing keyword
 * volumes multiplies a topic's demand by the number of variants, so demand is
 * counted once per canonical form and the raw sum is reported beside it.
 */

export type VolumeBearingQuery = { query: string; volume: number | null };

export function canonicalKeyword(query: string): string {
  return query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/s$/, "");
}

/** Distinct demand: the highest reported volume per canonical keyword, summed. */
export function distinctVolume(queries: VolumeBearingQuery[]): number {
  const byKey = new Map<string, number>();
  for (const query of queries) {
    if (query.volume == null) continue;
    const key = canonicalKeyword(query.query);
    if (!key) continue;
    byKey.set(key, Math.max(byKey.get(key) ?? 0, query.volume));
  }
  return [...byKey.values()].reduce((sum, value) => sum + value, 0);
}
