export type AgentTarget = {
  domain: string;
  repoPath: string;
  defaultBranch: string;
  bridgeRepoPath: string;
  bridgeSite: string;
  bridgeManifestPath: string;
  bridgeSiteRepoPath: string;
};

const TARGETS: AgentTarget[] = [
  {
    domain: "www.susimacdonald.com",
    repoPath: "/home/admin/susimacdonald-wix",
    defaultBranch: "main",
    bridgeRepoPath: "/home/admin/wix-site-bridge",
    bridgeSite: "susimacdonald",
    bridgeManifestPath: "/home/admin/wix-site-bridge/sites/susimacdonald/site.manifest.json",
    bridgeSiteRepoPath: "/home/admin/susimacdonald-wix",
  },
  {
    domain: "atelier-harmonie.com",
    repoPath: "/home/admin/atelier-harmonie",
    defaultBranch: "main",
    bridgeRepoPath: "/home/admin/wix-site-bridge",
    bridgeSite: "atelier-harmonie",
    bridgeManifestPath: "/home/admin/wix-site-bridge/sites/atelier-harmonie/site.manifest.json",
    bridgeSiteRepoPath: "/home/admin/atelier-harmonie",
  },
];

export function resolveAgentTarget(domain: string): AgentTarget | null {
  const normalized = domain.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return TARGETS.find((target) =>
    target.domain.replace(/^www\./, "").toLowerCase() === normalized,
  ) ?? null;
}

export function isWixBlogTarget(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return /^\/(?:post|blog)(?:\/|$)/i.test(new URL(url).pathname);
  } catch {
    return /\/(?:post|blog)(?:\/|$)/i.test(url);
  }
}

export function isTechnicalSeoAction(action: { source?: string | null; kind?: string | null }): boolean {
  return action.source === "crawl_issue" && action.kind === "fix_technical_issue";
}
