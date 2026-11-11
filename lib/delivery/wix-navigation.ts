import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { rebuildComponentPacket } from "@/lib/delivery/wix-early-packet";

const BRIDGE_ROOT = process.env.WIX_BRIDGE_ROOT?.trim() || "/home/admin/wix-site-bridge";

export type NavigationApplyResult = {
  status: "applied" | "skipped";
  target: string | null;
  component: string | null;
  packets: Array<{ id: string; name: string; characters: number; readback: string }>;
  reason?: string;
};

/** The `TARGET:` line the agent writes at the top of navigation.md. */
export function navigationTarget(notes: string): string | null {
  const match = notes.match(/^\s*TARGET:\s*(.+?)\s*$/im);
  if (!match) return null;
  const value = match[1].trim().replace(/^`|`$/g, "");
  if (!value || /^none$/i.test(value)) return null;
  return value;
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
 * Apply the navigation edit the agent prepared.
 *
 * The agent writes the complete edited component source; this writes it to the
 * site repository and rebuilds that component's early packet, so the new link
 * is live without a human touching the code. A target outside the repository's
 * custom-elements directory is refused.
 */
export async function applyNavigationEdit(taskId: string): Promise<NavigationApplyResult> {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, siteId: true, artifacts: { where: { kind: { in: ["navigation_notes", "navigation_source"] } }, select: { kind: true, content: true } } },
  });
  if (!task) return { status: "skipped", target: null, component: null, packets: [], reason: "task not found" };
  const notes = task.artifacts.find((artifact) => artifact.kind === "navigation_notes")?.content ?? "";
  const source = task.artifacts.find((artifact) => artifact.kind === "navigation_source")?.content ?? "";
  const target = navigationTarget(notes);
  if (!target) return { status: "skipped", target: null, component: null, packets: [], reason: "the agent chose a native menu" };
  if (!source.trim()) return { status: "skipped", target, component: null, packets: [], reason: "no edited source was produced" };

  const config = await getSiteDeliveryConfig(task.siteId);
  const repoPath = config?.repoPath?.trim();
  if (!config || !repoPath) return { status: "skipped", target, component: null, packets: [], reason: "the site has no connected repository" };

  const root = path.resolve(repoPath);
  const full = path.resolve(root, target);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { status: "skipped", target, component: null, packets: [], reason: "the target is outside the repository" };
  }
  if (!relative.startsWith(path.join("src", "public", "custom-elements"))) {
    return { status: "skipped", target, component: null, packets: [], reason: "the target is not a custom element source" };
  }

  const fileName = path.basename(full);
  const component = await componentNameForFile(config.bridgeAlias, fileName);
  if (!component) {
    return { status: "skipped", target, component: null, packets: [], reason: "the target is not a component in the site manifest" };
  }

  await writeFile(full, source, "utf8");
  const rebuilt = await rebuildComponentPacket({ siteId: task.siteId, componentName: component, source });
  return { status: "applied", target, component, packets: rebuilt.packets };
}
