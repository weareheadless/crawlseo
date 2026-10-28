export type ObservationLike = {
  id: string;
  provider: string;
  modelSurface: string;
  observedAt: Date;
};

export type CrawlIssueLike = {
  id: string;
  type: string;
  details: unknown;
};

export type ActionLike = {
  id: string;
  title: string;
  status: string;
  kind: string | null;
  source: string | null;
};

/** Fixture rows exist to prove the contract; they are never customer evidence. */
export function isFixtureObservation(row: Pick<ObservationLike, "provider" | "modelSurface">): boolean {
  return /fixture/i.test(row.modelSurface) || /fixture/i.test(row.provider);
}

export function splitObservations<T extends Pick<ObservationLike, "provider" | "modelSurface">>(
  rows: T[]
): { customer: T[]; fixtures: T[] } {
  const customer: T[] = [];
  const fixtures: T[] = [];
  for (const row of rows) (isFixtureObservation(row) ? fixtures : customer).push(row);
  return { customer, fixtures };
}

export function groupObservations<T extends ObservationLike>(
  rows: T[]
): Array<{ key: string; provider: string; modelSurface: string; rows: T[] }> {
  const groups = new Map<string, { key: string; provider: string; modelSurface: string; rows: T[] }>();
  for (const row of rows) {
    const key = `${row.provider} · ${row.modelSurface}`;
    const group = groups.get(key) ?? { key, provider: row.provider, modelSurface: row.modelSurface, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Provider exports are inconsistent: counts may be a number or a list of observations. */
export function observationCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.count === "number" && Number.isFinite(record.count)) return record.count;
    if (Array.isArray(record.items)) return record.items.length;
  }
  return null;
}

const IDENTITY_PATTERN = /schema|structured|jsonld|json-ld|identity|organization|sameas/i;

export function identityIssues<T extends CrawlIssueLike>(issues: T[]): T[] {
  return issues.filter((issue) => IDENTITY_PATTERN.test(`${issue.type} ${JSON.stringify(issue.details ?? {})}`));
}

export function groupIssuesByType<T extends CrawlIssueLike>(issues: T[]): Array<{ type: string; count: number; ids: string[] }> {
  const groups = new Map<string, { type: string; count: number; ids: string[] }>();
  for (const issue of issues) {
    const group = groups.get(issue.type) ?? { type: issue.type, count: 0, ids: [] };
    group.count += 1;
    group.ids.push(issue.id);
    groups.set(issue.type, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function summarizeDimensions<T extends ActionLike>(
  actions: T[],
  dimensionOf: (action: T) => string
): { aeo: Record<string, number>; geo: Record<string, number>; aeoTotal: number; geoTotal: number } {
  const result = {
    aeo: {} as Record<string, number>,
    geo: {} as Record<string, number>,
    aeoTotal: 0,
    geoTotal: 0,
  };
  for (const action of actions) {
    const dimension = dimensionOf(action);
    if (dimension !== "aeo" && dimension !== "geo") continue;
    const state = action.status.toLowerCase();
    result[dimension][state] = (result[dimension][state] ?? 0) + 1;
    if (dimension === "aeo") result.aeoTotal += 1;
    else result.geoTotal += 1;
  }
  return result;
}

export type AccessState = {
  crawlDate: string | null;
  robots: "restricted" | "clear" | "unknown";
  sitemap: "missing" | "clear" | "unknown";
  reachability: "responded" | "unknown";
};

export function accessState(
  crawl: { finishedAt: Date | null; issues: CrawlIssueLike[] } | null
): AccessState {
  if (!crawl) return { crawlDate: null, robots: "unknown", sitemap: "unknown", reachability: "unknown" };
  const robotsBlocked = crawl.issues.some(
    (issue) => issue.type === "MISSING_ROBOTS" || (issue.details as { kind?: string } | null)?.kind === "ai_crawler_block"
  );
  const sitemapMissing = crawl.issues.some((issue) => issue.type === "MISSING_SITEMAP");
  return {
    crawlDate: crawl.finishedAt ? crawl.finishedAt.toISOString() : null,
    robots: robotsBlocked ? "restricted" : "clear",
    sitemap: sitemapMissing ? "missing" : "clear",
    reachability: "responded",
  };
}
