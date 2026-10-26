export type SourceRecencyIssue = "missing_date" | "invalid_date" | "future_date" | "stale";

/** Classify evidence freshness without silently treating missing publication dates as current. */
export function sourceRecencyIssue(publishedAt: string | undefined, recencyDays: number, now = Date.now()): SourceRecencyIssue | null {
  if (!publishedAt) return "missing_date";
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return "invalid_date";
  const age = now - timestamp;
  if (age < -5 * 60_000) return "future_date";
  if (age > Math.max(1, Math.min(Math.floor(recencyDays), 730)) * 86_400_000) return "stale";
  return null;
}

export function sourceWithinRecencyWindow(publishedAt: string | undefined, recencyDays: number, now = Date.now()): boolean {
  return sourceRecencyIssue(publishedAt, recencyDays, now) === null;
}

/** Stored retrieval timestamps use the same bounded recency policy as source dates. */
export function observationWithinRecencyWindow(retrievedAt: Date | string | null | undefined, recencyDays: number, now = Date.now()): boolean {
  if (retrievedAt == null) return false;
  const value = retrievedAt instanceof Date ? retrievedAt.toISOString() : retrievedAt;
  return sourceRecencyIssue(value, recencyDays, now) === null;
}
