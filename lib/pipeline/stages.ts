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
  "keyword-research": "research", crawl: "findings", "aeo-geo": "findings", "content-studio": "work",
};

export function buildStageUrl(siteId: string, stage: PipelineStageId, suffix?: string): string {
  const safeSite = encodeURIComponent(siteId);
  const base = `/sites/${safeSite}${PIPELINE_STAGES.find((item) => item.id === stage)!.href}`;
  if (!suffix) return base;
  const safeSuffix = suffix.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${base}/${safeSuffix}`;
}

export function resolvePipelineStage(pathname: string): PipelineStageId | null {
  const parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
  const stageIndex = parts.findIndex((part) => PIPELINE_STAGES.some((stage) => stage.href.slice(1) === part));
  if (stageIndex >= 0) return PIPELINE_STAGES.find((stage) => stage.href.slice(1) === parts[stageIndex])!.id;
  for (const [lens, stage] of Object.entries(LEGACY_LENSES)) if (parts.includes(lens)) return stage;
  return null;
}
