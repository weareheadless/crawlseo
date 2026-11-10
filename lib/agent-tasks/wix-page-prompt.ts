export const MAX_PAGE_BYTES = 400_000;

export function markerFor(taskId: string): string {
  return `data-crawlseo-task="${taskId}"`;
}

export function buildWixPagePrompt(input: {
  taskId: string;
  domain: string;
  route: string;
  language: string;
  country: string | null;
  action: {
    title: string;
    recommendation: string;
    primaryQuery: string | null;
    kind: string;
    evidence: unknown;
  };
  draft: {
    title: string;
    metaTitle: string;
    metaDescription: string;
    markdown: string;
  } | null;
  operatorInstructions?: string;
}): string {
  const marker = markerFor(input.taskId);
  const routeAttribute = input.route.startsWith("(") ? "" : ` data-crawlseo-page="${input.route}"`;
  const evidence = JSON.stringify(input.action.evidence ?? {}, null, 2).slice(0, 12_000);
  const draft = input.draft
    ? [
        `TITLE: ${input.draft.title}`,
        `META TITLE: ${input.draft.metaTitle}`,
        `META DESCRIPTION: ${input.draft.metaDescription}`,
        "MARKDOWN:",
        input.draft.markdown.slice(0, 24_000),
      ].join("\n")
    : "No draft exists. Write the page from the evidence and recommendation.";

  return [
    "You are producing one Wix landing-page section.",
    "",
    `SITE: ${input.domain}`,
    `PAGE ROUTE: ${input.route}`,
    `LANGUAGE: ${input.language}`,
    `COUNTRY: ${input.country ?? "not specified"}`,
    `TARGET QUERY: ${input.action.primaryQuery ?? "none"}`,
    `ACTION: ${input.action.title}`,
    `KIND: ${input.action.kind}`,
    "",
    "RECOMMENDATION",
    input.action.recommendation,
    "",
    "EVIDENCE",
    evidence,
    "",
    "CONTENT DRAFT",
    draft,
    "",
    "DELIVERABLE",
    "Write exactly one file, page.html, in the current directory. Do not create or modify any other file.",
    "",
    "The file is a fragment, not a document. Its single root element must be:",
    `<section ${marker}${routeAttribute}>`,
    "",
    "REQUIREMENTS",
    "- Put every style inside one <style> block inside that section. Every selector must begin with the attribute selector for the marker, so no style can leak into the rest of the Wix page.",
    "- Semantic HTML: exactly one <h1>, then <h2> sections, short paragraphs, lists where they help, a FAQ when the draft has questions, and one clear call to action.",
    "- Include JSON-LD in a <script type=\"application/ld+json\"> block: WebPage always, FAQPage when there is a FAQ. Do not add claims that are not in the draft or evidence.",
    "- Internal links only to paths that exist on this site. Do not invent URLs.",
    "- No <html>, <head>, <body>, <iframe>, external fonts, external scripts, tracking pixels, or forms that submit.",
    "- Write in the page language. Keep the buyer's wording for the target query; do not translate it into marketing jargon.",
    "- The Wix page is blank and this embed replaces its content container, so this section is the whole page. It must stand on its own.",
    "",
    "The page is delivered to an existing Wix route. Do not try to create the page, call the Wix API, or publish anything. Produce the HTML only.",
    input.operatorInstructions ? `\nOPERATOR INSTRUCTIONS\n${input.operatorInstructions}` : "",
  ].filter(Boolean).join("\n");
}

/** The reasons a produced fragment cannot be delivered as a page. */
export function pageProblems(html: string, taskId: string): string[] {
  const problems: string[] = [];
  const trimmed = html.trim();
  if (!trimmed) return ["page.html is empty"];
  if (Buffer.byteLength(html, "utf8") > MAX_PAGE_BYTES) problems.push(`page.html exceeds ${MAX_PAGE_BYTES} bytes`);
  if (!trimmed.startsWith("<section")) problems.push("the root element must be a <section>");
  if (!trimmed.includes(markerFor(taskId))) problems.push(`the root section must carry ${markerFor(taskId)}`);
  if (/<html[\s>]/i.test(trimmed) || /<body[\s>]/i.test(trimmed)) problems.push("page.html must be a fragment, not a document");
  if (/<iframe[\s>]/i.test(trimmed)) problems.push("iframes are not allowed");
  return problems;
}
