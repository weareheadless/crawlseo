export type WorkCategory = "technical" | "content";

export function workCategory(action: {
  source?: string | null;
  kind?: string | null;
}): WorkCategory {
  return action.source === "crawl_issue" || action.kind === "fix_technical_issue"
    ? "technical"
    : "content";
}

export function workCategoryLabel(category: WorkCategory): string {
  return category === "technical" ? "Technical SEO" : "Content";
}
