export const PIPELINE_STAGES = [
  { id: "business", label: "Business", href: "/business", owner: "Business", inputs: "Your audience, services, markets and goals", outputs: "Business context for research and work" },
  { id: "research", label: "Research", href: "/research", owner: "Research", inputs: "Business context and research policy", outputs: "Evidence and research findings" },
  { id: "findings", label: "Findings", href: "/findings", owner: "Findings", inputs: "Recorded research and SEO evidence", outputs: "Actionable findings for Work" },
  { id: "work", label: "Work", href: "/work", owner: "Work", inputs: "Findings and selected actions", outputs: "Reviewed, delivered work and verification" },
  { id: "results", label: "Results", href: "/results", owner: "Results", inputs: "Delivery, verification and observations", outputs: "Measured changes and decisions" },
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number]["id"];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const LEGACY_LENSES: Readonly<Record<string, PipelineStageId>> = {
  "keyword-research": "research", keywords: "research", crawl: "findings", opportunities: "findings",
  findings: "findings", "aeo-geo": "findings", "content-studio": "work",
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
  if (route === "actions") return parts[offset + 3] ? "work" : null;
  const stage = PIPELINE_STAGES.find((item) => item.href.slice(1) === route);
  return stage?.id ?? LEGACY_LENSES[route] ?? null;
}
