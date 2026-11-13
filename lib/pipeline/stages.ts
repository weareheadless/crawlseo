export const PIPELINE_STAGES = [
  { id: "business", label: "Business", href: "/business", owner: "Business", inputs: "Your audience, services, markets and goals", outputs: "Business context for demand and work" },
  { id: "demand", label: "Demand", href: "/demand", owner: "Demand", inputs: "Business context, search and market evidence", outputs: "The demand map: clusters, queries and our position" },
  { id: "opportunities", label: "Opportunities", href: "/opportunities", owner: "Opportunities", inputs: "Demand map and recorded evidence", outputs: "Scored opportunities for a human decision" },
  { id: "work", label: "Work", href: "/work", owner: "Work", inputs: "Accepted opportunities", outputs: "Reviewed, delivered work and its receipts" },
  { id: "evidence", label: "Evidence", href: "/evidence", owner: "Evidence", inputs: "Every collection and research source", outputs: "The audit trail behind every score" },
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number]["id"];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * Routes that are not stages still belong to one. They are lenses on a stage,
 * never additional steps: a crawl is evidence, an old action is work.
 */
const LEGACY_LENSES: Readonly<Record<string, PipelineStageId>> = {
  "keyword-research": "evidence",
  keywords: "evidence",
  "saved-keywords": "evidence",
  crawl: "evidence",
  pages: "evidence",
  vitals: "evidence",
  alerts: "evidence",
  backlinks: "evidence",
  "aeo-geo": "evidence",
  "domain-overview": "evidence",
  research: "evidence",
  findings: "opportunities",
  intelligence: "opportunities",
  "legacy-opportunities": "opportunities",
  "content-studio": "work",
  actions: "work",
  results: "work",
  "legacy-work": "work",
};

export function buildStageUrl(siteId: string, stage: PipelineStageId, suffix?: string): string {
  if (typeof siteId !== "string" || !/^[A-Za-z0-9_-]+$/.test(siteId) || siteId === "." || siteId === "..") {
    throw new TypeError("siteId must be a nonempty site identifier without path or URL syntax");
  }
  const stageDefinition = PIPELINE_STAGES.find((item) => item.id === stage);
  if (!stageDefinition) throw new TypeError("Unknown pipeline stage");
  const base = `/sites/${siteId}${stageDefinition.href}`;
  if (suffix === undefined) return base;
  if (typeof suffix !== "string" || suffix.length === 0 || suffix.startsWith("/") || suffix.endsWith("/")) {
    throw new TypeError("suffix must be a relative nested path");
  }
  const parts = suffix.split("/");
  if (parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || part === "." || part === "..")) {
    throw new TypeError("suffix contains an invalid or traversing path segment");
  }
  return `${base}/${parts.join("/")}`;
}

export function resolvePipelineStage(pathname: string): PipelineStageId | null {
  if (typeof pathname !== "string") return null;
  let parts: string[];
  try {
    parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
  } catch {
    return null;
  }
  const offset = parts[0] === "crawlseo" ? 1 : 0;
  if (parts[offset] !== "sites" || !parts[offset + 1]) return null;
  const route = parts[offset + 2];
  if (!route || route === "settings") return null;
  const stage = PIPELINE_STAGES.find((item) => item.href.slice(1) === route);
  return stage?.id ?? LEGACY_LENSES[route] ?? null;
}
