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

  return [
    "You are implementing an approved CrawlSEO website action.",
    "",
    `SITE: ${input.siteDomain}`,
    `REPOSITORY: ${input.target.repoPath}`,
    `DEFAULT BRANCH: ${input.target.defaultBranch}`,
    `ROUTE: ${input.action.targetUrl ?? "(choose the closest mapped route)"}`,
    `ACTION: ${input.action.title}`,
    `KIND: ${input.action.kind}`,
    `FORMAT: ${input.action.format ?? "page_update"}`,
    `PRIORITY: ${input.action.priority}`,
    `PRIMARY QUERY: ${input.action.primaryQuery ?? "none"}`,
    "",
    "RECOMMENDATION",
    input.action.recommendation,
    "",
    ...(issueType === "MISSING_ALT"
      ? [
          "VISUAL SCOPE",
          "Attached screenshots are the source of truth for image content.",
          "Do not fetch or audit every affected URL. Use the screenshots and the shared template code.",
          "Identify the shared image-rendering code for the affected templates and add alt text there.",
          "Use alt=\"\" for decorative images. Do not infer alt text from filenames alone.",
          "",
        ]
      : []),
    ...(batch
      ? [
          "BATCH SCOPE",
          `This action covers ${String(evidenceRecord.affected_pages ?? affectedUrls.length)} affected pages across ${Array.isArray(evidenceRecord.route_families) ? evidenceRecord.route_families.length : "multiple"} templates.`,
          "Fix every affected template/page family listed in the evidence, not only the representative target route.",
          "Do not add a one-page special case. Apply the fix at the shared component, page-code, or template level.",
          "Verify sibling routes in each affected family remain unchanged and state the families you changed in your final summary.",
          "",
          `AFFECTED URLS (${affectedUrls.length} total; representative sample)`,
          representativeUrls.join("\n") || "(see evidence)",
          "",
        ]
      : [
          "TARGET SCOPE",
          `Target route: ${input.action.targetUrl ?? "(none)"}`,
          "If this route is one item in a shared template — a category, city, guide, product family, or similar — gate every content, SEO, and rendering change to that exact key or slug.",
          "Do not apply an item-specific change to every item that uses the same component or page model.",
          "When changing a shared component, verify that at least two sibling routes remain unchanged, and state the gating key and the sibling check in your final summary.",
          "",
        ]),
    "EVIDENCE",
    evidence,
    "",
    draft,
    "",
    "BRIDGE",
    `Shared bridge: ${input.target.bridgeRepoPath}`,
    `Bridge site alias: ${input.target.bridgeSite}`,
    `Manifest: ${input.target.bridgeManifestPath}`,
    `Site source repo: ${input.target.bridgeSiteRepoPath}`,
    "",
    "WORKTREE POLICY",
    "CrawlSEO has already created the dedicated worktree and branch for this task. The current working directory is that worktree.",
    "- Work only inside the current working directory.",
    "- Do not run `git worktree`, `git switch`, `git checkout`, `git checkout -b`, or `git branch` commands.",
    "- Do not edit the shared bridge repository at /home/admin/wix-site-bridge.",
    "- Do not modify any repository outside the prepared worktree.",
    "",
    "REQUIREMENTS",
    "- Make the smallest change that satisfies the action.",
    "- Preserve existing design, English/Spanish behavior, CMS bindings, routes and metadata unless the action explicitly requires a change.",
    "- Do not run `wix publish`, `bridge release --apply`, `bridge deploy --apply`, `git push`, or any Wix mutation.",
    "- You may run read-only inspection, code edits, lint/build/tests, and bridge dry-run/plan commands.",
    "- Produce a code/content diff and explain every changed file.",
    "- Run the relevant build/lint/tests.",
    "- Prepare the exact bridge plan command for human approval.",
    "- Do not claim a live change was published or verified.",
    input.operatorInstructions ? `\nOPERATOR INSTRUCTIONS\n${input.operatorInstructions}` : "",
  ].filter(Boolean).join("\n");
}
