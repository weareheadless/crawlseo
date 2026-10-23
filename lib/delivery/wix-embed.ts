import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { readBridgeSnippet, updateBridgeSnippet } from "@/lib/bridge/client";
import { addAgentArtifact } from "@/lib/agent-tasks/chat";

export class WixEmbedDeliveryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WixEmbedDeliveryError";
  }
}

type PacketEntry = [tag: string, gzipBase64: string];

function parseEntries(html: string): PacketEntry[] {
  const entries: PacketEntry[] = [];
  for (const match of html.matchAll(/\[\s*["']([a-z0-9-]+)["']\s*,\s*["']([A-Za-z0-9+/=]{20,})["']\s*\]/gi)) {
    entries.push([match[1], match[2]]);
  }
  return entries;
}

function replacePushCall(html: string, entries: PacketEntry[]): string {
  const marker = html.indexOf("__susiEarlyPackets");
  if (marker < 0) throw new WixEmbedDeliveryError("The snippet is not a Susi early packet", 409);
  const push = html.indexOf("push(", marker);
  if (push < 0) throw new WixEmbedDeliveryError("The packet push call could not be found", 409);
  const open = push + "push".length;
  let depth = 0;
  let quote = "";
  let escaped = false;
  let close = -1;
  for (let index = open; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) throw new WixEmbedDeliveryError("The packet push call is malformed", 409);
  const replacement = `(...${JSON.stringify(entries)})`;
  return html.slice(0, open) + replacement + html.slice(close + 1);
}

export function rebuildSusiEarlyPacket(currentHtml: string, targetTag: string, source: string): string {
  const entries = parseEntries(currentHtml);
  if (entries.length === 0) throw new WixEmbedDeliveryError("No packet entries were found in the snippet", 409);
  let replaced = false;
  const next = entries.map(([tag, base64]) => {
    if (tag !== targetTag) return [tag, base64] as PacketEntry;
    replaced = true;
    return [tag, gzipSync(Buffer.from(source, "utf8"), { level: 9 }).toString("base64")] as PacketEntry;
  });
  if (!replaced) {
    next.push([targetTag, gzipSync(Buffer.from(source, "utf8"), { level: 9 }).toString("base64")]);
  }
  return replacePushCall(currentHtml, next);
}

export function packetTags(html: string): string[] {
  return parseEntries(html).map(([tag]) => tag);
}

export function packetSource(html: string, tag: string): string | null {
  const entry = parseEntries(html).find(([name]) => name === tag);
  if (!entry) return null;
  try {
    return gunzipSync(Buffer.from(entry[1], "base64")).toString("utf8");
  } catch {
    return null;
  }
}

async function loadTaskAndTarget(taskId: string, targetKey: string) {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      siteId: true,
      status: true,
      worktreePath: true,
      actionId: true,
      title: true,
    },
  });
  if (!task) throw new WixEmbedDeliveryError("Agent task not found", 404);
  if (!task.worktreePath) throw new WixEmbedDeliveryError("Run the agent first to create a worktree", 409);
  const target = await db.deliveryTarget.findUnique({
    where: { siteId_key: { siteId: task.siteId, key: targetKey } },
  });
  if (!target || !target.enabled || !target.snippetId || !target.sourcePath || !target.componentTag) {
    throw new WixEmbedDeliveryError("Delivery target is not mapped to an editable embed packet", 409);
  }
  const delivery = await getSiteDeliveryConfig(task.siteId);
  if (!delivery?.enabled) throw new WixEmbedDeliveryError("Bridge delivery is not configured for this site", 409);
  return { task, target, delivery };
}

export async function planEmbedDelivery(taskId: string, targetKey: string) {
  const { task, target, delivery } = await loadTaskAndTarget(taskId, targetKey);
  const sourcePath = path.join(task.worktreePath!, target.sourcePath!);
  const source = await readFile(sourcePath, "utf8");
  const snippet = await readBridgeSnippet(delivery.bridgeAlias, target.snippetId!) as {
    snippet?: { embedData?: { html?: string } };
  };
  const currentHtml = snippet.snippet?.embedData?.html ?? "";
  const nextHtml = rebuildSusiEarlyPacket(currentHtml, target.componentTag!, source);

  const dir = path.join("/tmp/opencode", `embed-${task.id}`);
  await mkdir(dir, { recursive: true });
  const htmlFile = path.join(dir, `${target.componentTag}.html`);
  await writeFile(htmlFile, nextHtml, "utf8");

  const plan = await updateBridgeSnippet(delivery.bridgeAlias, target.snippetId!, htmlFile, false);
  const artifact = await addAgentArtifact(task.id, {
    kind: "embed_plan",
    content: JSON.stringify({ target: target.key, htmlFile, plan }, null, 2).slice(0, 100_000),
  });
  return { target, plan, artifact, htmlFile };
}

export async function applyEmbedDelivery(
  taskId: string,
  targetKey: string,
  confirmation: string,
) {
  if (confirmation !== `apply-embed:${taskId}:${targetKey}`) {
    throw new WixEmbedDeliveryError("Invalid embed delivery confirmation", 409);
  }
  const { task, target, delivery } = await loadTaskAndTarget(taskId, targetKey);
  if (task.status !== "COMMITTED") {
    throw new WixEmbedDeliveryError("Commit the agent changes before applying the embed", 409);
  }
  const sourcePath = path.join(task.worktreePath!, target.sourcePath!);
  const source = await readFile(sourcePath, "utf8");
  const snippet = await readBridgeSnippet(delivery.bridgeAlias, target.snippetId!) as {
    snippet?: { embedData?: { html?: string } };
  };
  const nextHtml = rebuildSusiEarlyPacket(snippet.snippet?.embedData?.html ?? "", target.componentTag!, source);
  const dir = path.join("/tmp/opencode", `embed-${task.id}`);
  await mkdir(dir, { recursive: true });
  const htmlFile = path.join(dir, `${target.componentTag}.html`);
  await writeFile(htmlFile, nextHtml, "utf8");
  const receipt = await updateBridgeSnippet(delivery.bridgeAlias, target.snippetId!, htmlFile, true);
  await addAgentArtifact(task.id, {
    kind: "embed_receipt",
    content: JSON.stringify(receipt, null, 2).slice(0, 100_000),
  });
  const updated = await db.agentTask.update({
    where: { id: task.id },
    data: {
      status: "PUBLISHED",
      bridgeReceiptId: (receipt as { operationId?: string; releaseId?: string }).operationId
        ?? (receipt as { releaseId?: string }).releaseId
        ?? null,
      publishedUrl: target.route ?? null,
      completedAt: new Date(),
    },
  });
  if (task.actionId) {
    await db.delivery.create({
      data: {
        actionId: task.actionId,
        platform: "wix_embed",
        externalId: target.snippetId!,
        status: "PUBLISHED",
        payload: { target: target.key, receipt: JSON.parse(JSON.stringify(receipt)) },
        verifiedAt: new Date(),
      },
    });
  }
  return { task: updated, receipt };
}

export async function verifyEmbedDelivery(taskId: string, targetKey: string) {
  const { task, target, delivery } = await loadTaskAndTarget(taskId, targetKey);
  const sourcePath = path.join(task.worktreePath!, target.sourcePath!);
  const source = await readFile(sourcePath, "utf8");
  const snippet = await readBridgeSnippet(delivery.bridgeAlias, target.snippetId!) as {
    snippet?: { embedData?: { html?: string } };
  };
  const currentHtml = snippet.snippet?.embedData?.html ?? "";
  const expectedHtml = rebuildSusiEarlyPacket(currentHtml, target.componentTag!, source);
  const result = {
    verified: currentHtml === expectedHtml,
    target: target.key,
    snippetId: target.snippetId,
    componentTag: target.componentTag,
    expectedSha256: createHash("sha256").update(expectedHtml).digest("hex"),
    actualSha256: createHash("sha256").update(currentHtml).digest("hex"),
  };
  await addAgentArtifact(task.id, { kind: "embed_verify", content: JSON.stringify(result, null, 2) });
  return result;
}
