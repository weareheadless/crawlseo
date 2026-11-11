export const MAX_PAGE_BYTES = 400_000;

/** The stored design facts a page task must follow. */
export type DesignReference = {
  repoPath: string | null;
  palette: string[];
  fonts: string[];
  notes: string;
};

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
  design?: DesignReference | null;
  liveUrl?: string | null;
  operatorInstructions?: string;
}): string {
  const marker = markerFor(input.taskId);
  const routeAttribute = input.route.startsWith("(") ? "" : ` data-crawlseo-page="${input.route}"`;
  const design = input.design;
  const designLines = [
    "DESIGN REFERENCE",
    design?.repoPath
      ? `Repository (read-only, do not modify): ${design.repoPath}`
      : "No repository is configured for this site.",
    design?.palette.length
      ? `Palette already in use: ${design.palette.join(", ")}`
      : "No stored palette. Derive it from the repository or the live site.",
    design?.fonts.length
      ? `Fonts already in use: ${design.fonts.join(", ")}`
      : "No stored fonts. Derive them from the repository or the live site.",
    design?.notes ? `Design notes: ${design.notes}` : "",
    design?.repoPath
      ? "Read the repository's custom elements, page styles and components before writing. Reuse its palette, typography, spacing, radii, button and card patterns."
      : "Read the live site's rendered styles before writing.",
    input.liveUrl ? `Live site for rendered reference: ${input.liveUrl}` : "",
    "Do not invent a new visual language. If the reference is ambiguous, choose the closest existing token rather than a new colour or font.",
  ].filter(Boolean).join("\n");
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
    designLines,
    "",
    "DELIVERABLE",
    "Write page.html in the current directory, plus design-notes.md and navigation.md. Do not create or modify any other file.",
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
    "- Use the design reference's colours and fonts. Do not substitute a new palette or typeface.",
    "- The Wix page is blank and this embed replaces its content container, so this section is the whole page. It must stand on its own.",
    "",
    "Also write design-notes.md in the current directory: a short list of the palette, fonts, spacing and component patterns you used, and the file or page where you found each. Do not invent tokens.",
    "",
    "Also write navigation.md: the best way a visitor reaches this new page. Read the site's navigation and footer sources in the repository, then choose one target and give the exact edit. Cover:",
    "- the target (the menu, the footer, or a named existing page) and the file and location inside it;",
    "- the link text in the page language and the href;",
    "- why this is the best place for this page, and what you rejected;",
    "- whether the target is a repository component the agent can edit, or a native Wix menu a human must change.",
    "Do not invent a menu item that duplicates an existing one, and do not link the page from itself.",
    "",
    "The page is delivered to an existing Wix route. Do not try to create the page, call the Wix API, or publish anything. Produce page.html, design-notes.md and navigation.md only.",
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
