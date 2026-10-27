export type WorkCategory = "technical" | "content";

export const actionDimensions = ["seo", "aeo", "geo", "content", "technical"] as const;
export type ActionDimension = (typeof actionDimensions)[number];

/** Derive the owner-facing dimension from the action's canonical origin and kind. */
export function actionDimension(action: { source?: string | null; kind?: string | null }): ActionDimension {
  const source = action.source ?? "";
  const kind = action.kind ?? "";
  if (/business_identity|identity_jsonld/i.test(kind)) return "aeo";
  if (source === "ai_visibility_coverage" || kind === "missing_evidence") return "aeo";
  if (/visibility|geo/i.test(source) || /visibility|citation|mention/i.test(kind)) return "geo";
  if (source === "crawl_issue") {
    return /technical|schema|canonical|robots|sitemap/i.test(kind) ? "technical" : "seo";
  }
  if (/fix_technical_issue|schema|canonical|robots|sitemap/i.test(kind)) return "technical";
  if (/broken_link/i.test(kind)) return "seo";
  if (/content|article|section|faq|metadata|page/i.test(kind) || source === "keyword_research" || source === "seo_opportunity") return "content";
  return "seo";
}

export function filterActions<T extends { source?: string | null; kind?: string | null; status: string }>(
  actions: T[], dimension: ActionDimension | "all", state: string | "all",
) {
  const filtered = actions.filter((action) => (dimension === "all" || actionDimension(action) === dimension)
    && (state === "all" || action.status === state));
  return { actions: filtered, count: filtered.length };
}

export function workCategory(action: {
  source?: string | null;
  kind?: string | null;
}): WorkCategory {
  return action.kind === "fix_technical_issue"
    ? "technical"
    : "content";
}

export function workCategoryLabel(category: WorkCategory): string {
  return category === "technical" ? "Technical SEO" : "Content";
}
