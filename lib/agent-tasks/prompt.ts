import type { AgentTarget } from "@/lib/agent-tasks/targets";

export type AgentPromptInput = {
  target: AgentTarget;
  siteDomain: string;
  action: {
    title: string;
    recommendation: string;
    kind: string;
    format: string | null;
    targetUrl: string | null;
    primaryQuery: string | null;
    priority: number;
    evidence: unknown;
  };
  draft?: {
    title: string;
    markdown: string;
    metaTitle: string;
    metaDescription: string;
  } | null;
  operatorInstructions?: string;
};

export function buildAgentPrompt(input: AgentPromptInput): string {
  const evidenceRecord = input.action.evidence && typeof input.action.evidence === "object" && !Array.isArray(input.action.evidence)
    ? input.action.evidence as Record<string, unknown>
    : {};
  const batch = evidenceRecord.batch === true;
  const affectedUrls = Array.isArray(evidenceRecord.urls)
    ? evidenceRecord.urls.filter((url): url is string => typeof url === "string")
    : [];
  const issueType = typeof evidenceRecord.issue_type === "string" ? evidenceRecord.issue_type : "";
  const representativeUrls: string[] = [];
  const families = new Set<string>();
  for (const url of [input.action.targetUrl, ...affectedUrls].filter((value): value is string => Boolean(value))) {
    if (representativeUrls.includes(url)) continue;
    let family = url;
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      family = parts.slice(0, 2).join("/") || "home";
    } catch {
      // Keep the raw URL as the family key.
    }
    if (families.has(family)) continue;
    families.add(family);
    representativeUrls.push(url);
    if (representativeUrls.length >= 12) break;
  }
  const promptEvidence = {
    ...evidenceRecord,
    urls: representativeUrls,
    ...(issueType !== "BROKEN_LINK" ? { broken_urls: undefined } : {}),
    ...(evidenceRecord.live_check && typeof evidenceRecord.live_check === "object" && !Array.isArray(evidenceRecord.live_check)
      ? {
          live_check: {
            ...(evidenceRecord.live_check as Record<string, unknown>),
            checked_urls: representativeUrls.slice(0, 6),
          },
        }
      : {}),
  };
  const evidence = JSON.stringify(promptEvidence, null, 2).slice(0, 12_000);
  const draft = input.draft
    ? [
        "CURRENT CONTENT DRAFT",
        `Title: ${input.draft.title}`,
        `Meta title: ${input.draft.metaTitle}`,
        `Meta description: ${input.draft.metaDescription}`,
        "Markdown:",
        input.draft.markdown.slice(0, 20_000),
      ].join("\n")
    : "No content draft exists yet. Use the action evidence and recommendation.";

  const scope = batch
    ? [
        "SCOPE",
        `This action covers ${String(evidenceRecord.affected_pages ?? affectedUrls.length)} pages across ${Array.isArray(evidenceRecord.route_families) ? evidenceRecord.route_families.length : "multiple"} templates.`,
        "Fix the shared template(s) that produce the issue. Use the attached screenshots and evidence. Keep sibling routes unchanged.",
        "",
        `AFFECTED URLS (${affectedUrls.length} total; representative sample)`,
        representativeUrls.join("\n") || "(see evidence)",
      ]
    : [
        "SCOPE",
        `Target: ${input.action.targetUrl ?? "(none)"}`,
        "Keep the change scoped to this route/template. Verify sibling routes remain unchanged.",
      ];

  return [
    "You are implementing an approved CrawlSEO website action.",
    "",
    `SITE: ${input.siteDomain}`,
    `REPOSITORY: ${input.target.repoPath}`,
    `ROUTE: ${input.action.targetUrl ?? "(choose the closest mapped route)"}`,
    `ACTION: ${input.action.title}`,
    `KIND: ${input.action.kind}`,
    `FORMAT: ${input.action.format ?? "page_update"}`,
    `PRIMARY QUERY: ${input.action.primaryQuery ?? "none"}`,
    "",
    "RECOMMENDATION",
    input.action.recommendation,
    "",
    ...scope,
    "",
    "EVIDENCE",
    evidence,
    "",
    draft,
    "",
    "USER-FACING COPY",
    "Every visible string — headings, buttons, filter labels, empty states, alt text — must come from the page's own locale copy, never from constants inside a shared component. When a page publishes several locales, declare the locale in each config and keep the component's chrome in one copy map, so no language can leak into another.",
    "",
    "WORKTREE",
    "Work only in the current worktree. Do not switch branches, modify other repositories, publish, or mutate Wix; the release pipeline handles publication.",
    "Run the relevant tests and report changed files, test results, and any uncertainty.",
    input.operatorInstructions ? `\nOPERATOR INSTRUCTIONS\n${input.operatorInstructions}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Point the agent at its own checkout.
 *
 * The stored brief names the repository so it reads self-contained, but the
 * run happens in a worktree. An agent that follows the absolute repository path
 * edits the shared checkout; that is how a run inside a worktree still left two
 * files modified in the main repository.
 */
export function worktreeBrief(prompt: string, worktreePath: string): string {
  return [
    `WORKING COPY: ${worktreePath}`,
    "Make every edit inside that directory and run commands from it. The repository named in the brief is the shared checkout: read it if you must, but never write to it.",
    "",
    prompt.replace(/^REPOSITORY:.*$/m, `REPOSITORY: ${worktreePath}`),
  ].join("\n");
}
