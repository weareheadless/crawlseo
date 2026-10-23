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
  const evidence = JSON.stringify(input.action.evidence, null, 2).slice(0, 12_000);
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
    "REQUIREMENTS",
    "- Work in a dedicated branch or worktree. Never work directly on main.",
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
