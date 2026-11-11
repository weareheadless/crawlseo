import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { rebuildComponentPacket } from "@/lib/delivery/wix-early-packet";

const BRIDGE_ROOT = process.env.WIX_BRIDGE_ROOT?.trim() || "/home/admin/wix-site-bridge";

/**
 * The navigation edit the agent decided, as exact string replacements.
 *
 * The agent picks the target and the link; the system applies the strings and
 * refuses an ambiguous one, because retyping a 32 KB minified component is a
 * copy error waiting to happen.
 */
export type NavigationPlan = {
  target: string;
  component: string;
  summary: string;
  edits: Array<{ find: string; replace: string }>;
};

export type NavigationApplyResult = {
  status: "applied" | "skipped";
  target: string | null;
  component: string | null;
  packets: Array<{ id: string; name: string; characters: number; readback: string }>;
  reason?: string;
};

export function parseNavigationPlan(value: unknown): NavigationPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const target = typeof row.target === "string" ? row.target.trim() : "";
  const component = typeof row.component === "string" ? row.component.trim() : "";
  const edits = Array.isArray(row.edits)
    ? row.edits
        .map((edit) => {
          if (!edit || typeof edit !== "object" || Array.isArray(edit)) return null;
          const item = edit as Record<string, unknown>;
          const find = typeof item.find === "string" ? item.find : "";
          const replace = typeof item.replace === "string" ? item.replace : "";
          return find && find !== replace ? { find, replace } : null;
        })
        .filter((edit): edit is { find: string; replace: string } => Boolean(edit))
    : [];
  if (!target || !component || edits.length === 0) return null;
  return {
    target,
    component,
    summary: typeof row.summary === "string" ? row.summary : "",
    edits,
  };
}

/** Apply the plan's replacements, refusing a string that is missing or ambiguous. */
export function applyNavigationPlan(source: string, plan: NavigationPlan): string {
  let next = source;
  for (const [index, edit] of plan.edits.entries()) {
    const occurrences = next.split(edit.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Navigation edit ${index + 1} matches ${occurrences} places; it must match exactly one`);
    }
    next = next.replace(edit.find, edit.replace);
  }
  // A component source is a script; a syntax error would take the header down.
  new Function(next);
  return next;
}

async function componentNameForFile(alias: string, fileName: string): Promise<string | null> {
  const manifestPath = path.join(BRIDGE_ROOT, "sites", alias, "site.manifest.json");
  const raw = await readFile(manifestPath, "utf8").catch(() => "");
  if (!raw) return null;
  try {
    const manifest = JSON.parse(raw) as { site?: { components?: Array<{ name?: string; source?: string }> } };
    const component = (manifest.site?.components ?? []).find((entry) => entry.source?.endsWith(`/${fileName}`));
    return component?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply the navigation edit the agent prepared: write the edited source into
 * the site repository and rebuild that component's early packet.
 */
export async function applyNavigationEdit(taskId: string): Promise<NavigationApplyResult> {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, siteId: true, artifacts: { where: { kind: "navigation_edits" }, orderBy: { createdAt: "desc" }, take: 1, select: { content: true } } },
  });
  if (!task) return { status: "skipped", target: null, component: null, packets: [], reason: "task not found" };
  const raw = task.artifacts[0]?.content ?? "";
  if (!raw.trim()) return { status: "skipped", target: null, component: null, packets: [], reason: "the agent chose no repository edit" };
  let plan: NavigationPlan | null = null;
  try {
    plan = parseNavigationPlan(JSON.parse(raw));
  } catch {
    return { status: "skipped", target: null, component: null, packets: [], reason: "the navigation plan is not valid JSON" };
  }
  if (!plan) return { status: "skipped", target: null, component: null, packets: [], reason: "the navigation plan is incomplete" };

  const config = await getSiteDeliveryConfig(task.siteId);
  const repoPath = config?.repoPath?.trim();
  if (!config || !repoPath) return { status: "skipped", target: plan.target, component: null, packets: [], reason: "the site has no connected repository" };

  const root = path.resolve(repoPath);
  const full = path.resolve(root, plan.target);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { status: "skipped", target: plan.target, component: null, packets: [], reason: "the target is outside the repository" };
  }
  if (!relative.startsWith(path.join("src", "public", "custom-elements"))) {
    return { status: "skipped", target: plan.target, component: null, packets: [], reason: "the target is not a custom element source" };
  }

  const current = await readFile(full, "utf8").catch(() => "");
  if (!current) return { status: "skipped", target: plan.target, component: null, packets: [], reason: "the target file does not exist" };
  let next: string;
  try {
    next = applyNavigationPlan(current, plan);
  } catch (error) {
    return { status: "skipped", target: plan.target, component: null, packets: [], reason: error instanceof Error ? error.message : "the edit could not be applied" };
  }

  const component = plan.component || await componentNameForFile(config.bridgeAlias, path.basename(full));
  if (!component) return { status: "skipped", target: plan.target, component: null, packets: [], reason: "the target is not a component in the site manifest" };

  await writeFile(full, next, "utf8");
  const rebuilt = await rebuildComponentPacket({ siteId: task.siteId, componentName: component, source: next });
  return { status: "applied", target: plan.target, component, packets: rebuilt.packets };
}
