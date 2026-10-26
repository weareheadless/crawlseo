import { db } from "@/lib/db";

/**
 * The only executor that approves, prepares, publishes or dismisses owner work
 * from CrawlSEO itself. Any other active executor (currently `helloada`) owns
 * those decisions in its own review surface.
 */
export const LOCAL_EXECUTION_EXECUTOR = "crawlseo-agent";

export const EXTERNAL_EXECUTION_MESSAGE =
  "This Action is managed in HelloAda. Approve, dismiss or publish it there.";

export type ConnectorAuthority = {
  status?: string | null;
  executor?: string | null;
} | null | undefined;

export type ExecutionAuthority = {
  managed: boolean;
  executor: string | null;
  reviewOrigin: string | null;
};

export function isExternallyManaged(binding: ConnectorAuthority): boolean {
  return binding?.status === "ACTIVE" && binding.executor !== LOCAL_EXECUTION_EXECUTOR;
}

/** Host-level identity so `www`, scheme, path and case differences cannot fork a domain. */
export function normalizeSiteDomain(domain: string | null | undefined): string {
  let value = (domain ?? "").trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");
  value = value.split(/[/?#]/)[0];
  value = value.replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  return value;
}

function reviewOriginFrom(capabilities: unknown): string | null {
  const value = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? (capabilities as Record<string, unknown>).reviewOrigin
    : null;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    return null;
  }
}

export function executionAuthority(
  binding: ConnectorAuthority,
  capabilities?: unknown,
): ExecutionAuthority {
  const managed = isExternallyManaged(binding);
  return {
    managed,
    executor: managed ? String(binding?.executor) : LOCAL_EXECUTION_EXECUTOR,
    reviewOrigin: managed ? reviewOriginFrom(capabilities) : null,
  };
}

type SiteAuthorityInput = {
  id: string;
  projectId: string | null;
  domain: string;
  connectorBinding: ConnectorAuthority;
  connectorContext?: { capabilities: unknown } | null;
};

type SiblingAuthority = {
  projectId: string | null;
  domain: string;
  connectorBinding: ConnectorAuthority;
  connectorContext?: { capabilities: unknown } | null;
};

/**
 * Resolve who owns owner work for a site. A site that is itself bound to an
 * external executor is owned there. An unbound duplicate is owned by the bound
 * sibling for the same domain, so the two rows cannot fork owner decisions.
 */
export async function resolveSiteAuthority(site: SiteAuthorityInput): Promise<ExecutionAuthority> {
  if (isExternallyManaged(site.connectorBinding)) {
    return executionAuthority(site.connectorBinding, site.connectorContext?.capabilities);
  }

  const domain = normalizeSiteDomain(site.domain);
  if (domain && site.projectId) {
    const siblings: SiblingAuthority[] = await db.site.findMany({
      // Domain equality is only meaningful inside a tenant. A domain may be
      // managed independently by two CrawlSEO projects.
      where: { id: { not: site.id }, projectId: site.projectId },
      select: {
        projectId: true,
        domain: true,
        connectorBinding: { select: { executor: true, status: true } },
        connectorContext: { select: { capabilities: true } },
      },
    });
    const canonical = siblings.find((sibling) =>
      normalizeSiteDomain(sibling.domain) === domain && isExternallyManaged(sibling.connectorBinding));
    if (canonical) {
      return executionAuthority(canonical.connectorBinding, canonical.connectorContext?.capabilities);
    }
  }

  return executionAuthority(site.connectorBinding, site.connectorContext?.capabilities);
}

export async function getActionExecutionAuthority(actionId: string): Promise<ExecutionAuthority | null> {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    select: {
      site: {
        select: {
          id: true,
          projectId: true,
          domain: true,
          connectorBinding: { select: { executor: true, status: true } },
          connectorContext: { select: { capabilities: true } },
        },
      },
    },
  });
  if (!action) return null;
  return resolveSiteAuthority(action.site);
}

export async function getSiteExecutionAuthority(siteId: string): Promise<ExecutionAuthority | null> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      projectId: true,
      domain: true,
      connectorBinding: { select: { executor: true, status: true } },
      connectorContext: { select: { capabilities: true } },
    },
  });
  if (!site) return null;
  return resolveSiteAuthority(site);
}

/**
 * True when another site for the same domain has handed owner work to an
 * external executor. The local site is then a duplicate: it may still be read,
 * but it must not produce a second set of Actions for the same business.
 */
export async function isSupersededByExternalAuthority(siteId: string): Promise<boolean> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      projectId: true,
      domain: true,
      connectorBinding: { select: { executor: true, status: true } },
    },
  });
  if (!site) return false;
  if (isExternallyManaged(site.connectorBinding)) return false;
  if (!site.projectId) return false;

  const domain = normalizeSiteDomain(site.domain);
  if (!domain) return false;

  const siblings = await db.site.findMany({
    where: { id: { not: site.id }, projectId: site.projectId },
    select: {
      projectId: true,
      domain: true,
      connectorBinding: { select: { executor: true, status: true } },
    },
  });
  return siblings.some((sibling) =>
    normalizeSiteDomain(sibling.domain) === domain && isExternallyManaged(sibling.connectorBinding));
}

export type SiteBindingRow = {
  id: string;
  projectId: string | null;
  domain: string;
  connectorBinding: ConnectorAuthority;
};

/**
 * A same-project, same-domain row is superseded when another row for that
 * domain has an active external executor. Superseded rows stay as immutable
 * audit anchors (for example legacy budget-transfer receipts), but they are
 * not separate sites to show or act on.
 */
export function supersededSiteIds(sites: readonly SiteBindingRow[]): Set<string> {
  const groups = new Map<string, SiteBindingRow[]>();
  for (const site of sites) {
    if (!site.projectId) continue;
    const domain = normalizeSiteDomain(site.domain);
    if (!domain) continue;
    const key = `${site.projectId}\u0000${domain}`;
    const group = groups.get(key) ?? [];
    group.push(site);
    groups.set(key, group);
  }

  const superseded = new Set<string>();
  for (const group of groups.values()) {
    const managed = group.filter((site) => isExternallyManaged(site.connectorBinding));
    if (managed.length === 0) continue;
    for (const site of group) {
      if (!managed.includes(site)) superseded.add(site.id);
    }
  }
  return superseded;
}

export async function getSupersededSiteIds(): Promise<Set<string>> {
  const sites = await db.site.findMany({
    select: {
      id: true,
      projectId: true,
      domain: true,
      connectorBinding: { select: { executor: true, status: true } },
    },
  });
  return supersededSiteIds(sites);
}
