import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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

export function rebuildAtelierEarlyPacket(currentHtml: string, packetKey: string, source: string): string {
  const encoded = gzipSync(Buffer.from(source, "utf8"), { level: 9 }).toString("base64");
  const escaped = packetKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`("key":"${escaped}"[\\s\\S]*?"encoded":")[^"]+(")`);
  if (!pattern.test(currentHtml)) {
    throw new WixEmbedDeliveryError(`Atelier packet key ${packetKey} was not found in the snippet`, 409);
  }
  return currentHtml.replace(pattern, `$1${encoded}$2`);
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
      actionRevision: true,
      connectorGeneration: true,
      title: true,
      commitSha: true,
      action: { select: { revision: true } },
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
  const binding = await db.connectorBinding.findUnique({
    where: { siteId: task.siteId },
    select: { id: true, executor: true, generation: true, status: true },
  });
  return { task, target, delivery, binding };
}

async function reviewedSource(task: {
  worktreePath: string | null; commitSha: string | null;
}, sourcePath: string) {
  if (!task.worktreePath || !task.commitSha) {
    throw new WixEmbedDeliveryError("A committed, reviewed source revision is required before applying an embed", 409);
  }
  const status = await execFileAsync("git", ["-C", task.worktreePath, "status", "--porcelain", "--", sourcePath], {
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  if (status.stdout.trim()) throw new WixEmbedDeliveryError("Reviewed embed source has uncommitted changes", 409);
  const head = (await execFileAsync("git", ["-C", task.worktreePath, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
  if (head !== task.commitSha) throw new WixEmbedDeliveryError("The task no longer points at its reviewed commit", 409);
  const committed = (await execFileAsync("git", ["-C", task.worktreePath, "show", `${task.commitSha}:${sourcePath}`], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout;
  const current = await readFile(path.join(task.worktreePath, sourcePath), "utf8");
  if (current !== committed) throw new WixEmbedDeliveryError("Embed source differs from the reviewed commit", 409);
  return current;
}

export function assertWixEmbedExecutionBinding(task: {
  actionId: string | null; actionRevision: number | null; connectorGeneration: number | null;
  action: { revision: number } | null;
}, binding: { id: string; executor: string; generation: number; status: string } | null) {
  if (task.actionId && (task.actionRevision === null || task.action?.revision !== task.actionRevision)) {
    throw new WixEmbedDeliveryError("Action revision changed since this task was reviewed", 409);
  }
  if (binding && (binding.status !== "ACTIVE" || binding.executor !== "crawlseo-agent"
      || task.connectorGeneration !== binding.generation)) {
    throw new WixEmbedDeliveryError("The Wix execution binding changed since this task was prepared", 409);
  }
}

export function wixEmbedEffectToken(input: Record<string, unknown>) {
  return sha256(JSON.stringify(input));
}

export function wixEmbedReadbackMatches(html: string, desiredSha256: string) {
  return sha256(html) === desiredSha256;
}

function buildPacket(currentHtml: string, target: { componentTag: string | null; metadata: unknown }, source: string): string {
  const metadata = target.metadata && typeof target.metadata === "object" && !Array.isArray(target.metadata)
    ? target.metadata as Record<string, unknown>
    : {};
  const packetFormat = typeof metadata.packetFormat === "string" ? metadata.packetFormat : "";
  const packetKey = typeof metadata.packetKey === "string" ? metadata.packetKey : target.componentTag;
  if (!target.componentTag || !packetKey) {
    throw new WixEmbedDeliveryError("Delivery target is missing its component tag or packet key", 409);
  }
  return packetFormat === "atelier-v51"
    ? rebuildAtelierEarlyPacket(currentHtml, packetKey, source)
    : rebuildSusiEarlyPacket(currentHtml, target.componentTag, source);
}

export async function planEmbedDelivery(taskId: string, targetKey: string) {
  const { task, target, delivery, binding } = await loadTaskAndTarget(taskId, targetKey);
  assertWixEmbedExecutionBinding(task, binding);
  const sourcePath = path.join(task.worktreePath!, target.sourcePath!);
  const source = task.status === "COMMITTED" || task.status === "APPROVED"
    ? await reviewedSource(task, target.sourcePath!)
    : await readFile(sourcePath, "utf8");
  const snippet = await readBridgeSnippet(delivery.bridgeAlias, target.snippetId!) as {
    snippet?: { embedData?: { html?: string } };
  };
  const currentHtml = snippet.snippet?.embedData?.html ?? "";
  const nextHtml = buildPacket(currentHtml, target, source);
  const effect = {
    taskId: task.id,
    siteId: task.siteId,
    actionId: task.actionId,
    actionRevision: task.actionRevision,
    bindingId: binding?.id ?? null,
    bindingGeneration: binding?.generation ?? null,
    alias: delivery.bridgeAlias,
    targetKey: target.key,
    snippetId: target.snippetId,
    componentTag: target.componentTag,
    sourcePath: target.sourcePath,
    scopeSha256: sha256(JSON.stringify(target.metadata ?? null)),
    commitSha: task.commitSha,
    sourceSha256: sha256(source),
    currentHtmlSha256: sha256(currentHtml),
    desiredHtmlSha256: sha256(nextHtml),
  };
  const token = wixEmbedEffectToken(effect);

  const dir = path.join("/tmp/opencode", `embed-${task.id}`);
  await mkdir(dir, { recursive: true });
  const htmlFile = path.join(dir, `${target.componentTag}.html`);
  await writeFile(htmlFile, nextHtml, "utf8");

  const plan = await updateBridgeSnippet(delivery.bridgeAlias, target.snippetId!, htmlFile, false);
  const artifact = await addAgentArtifact(task.id, {
    kind: "embed_plan",
    content: JSON.stringify({ target: target.key, htmlFile, effect, token, plan }, null, 2).slice(0, 100_000),
  });
  return { target, plan, artifact, htmlFile, confirmation: `apply-embed:${task.id}:${target.key}:${token}` };
}

export async function applyEmbedDelivery(
  taskId: string,
  targetKey: string,
  confirmation: string,
) {
  const { task, target, delivery, binding } = await loadTaskAndTarget(taskId, targetKey);
  if (task.status !== "COMMITTED") {
    throw new WixEmbedDeliveryError("Commit the agent changes before applying the embed", 409);
  }
  assertWixEmbedExecutionBinding(task, binding);
  const artifacts = await db.agentTaskArtifact.findMany({
    where: { taskId, kind: { in: ["embed_plan", "embed_apply_started", "embed_apply_unknown", "embed_receipt", "embed_partial_receipt"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, kind: true, content: true, createdAt: true },
  });
  const priorApply = artifacts.find((item) => item.kind !== "embed_plan");
  if (priorApply) throw new WixEmbedDeliveryError("An embed apply already has a receipt or uncertain outcome; reconcile it before retrying", 409);
  const planArtifact = artifacts.find((item) => item.kind === "embed_plan");
  if (!planArtifact?.content) throw new WixEmbedDeliveryError("Plan the exact embed effect before applying it", 409);
  let prepared: { target?: string; effect?: Record<string, unknown>; token?: string };
  try { prepared = JSON.parse(planArtifact.content) as typeof prepared; }
  catch { throw new WixEmbedDeliveryError("The saved embed plan is unreadable; create a new plan", 409); }
  if (prepared.target !== targetKey || confirmation !== `apply-embed:${taskId}:${targetKey}:${prepared.token}`) {
    throw new WixEmbedDeliveryError("Confirmation does not authorize this exact embed effect", 409);
  }
  const source = await reviewedSource(task, target.sourcePath!);
  const snippet = await readBridgeSnippet(delivery.bridgeAlias, target.snippetId!) as {
    snippet?: { embedData?: { html?: string } };
  };
  const currentHtml = snippet.snippet?.embedData?.html ?? "";
  const nextHtml = buildPacket(currentHtml, target, source);
  const effect = {
    taskId: task.id,
    siteId: task.siteId,
    actionId: task.actionId,
    actionRevision: task.actionRevision,
    bindingId: binding?.id ?? null,
    bindingGeneration: binding?.generation ?? null,
    alias: delivery.bridgeAlias,
    targetKey: target.key,
    snippetId: target.snippetId,
    componentTag: target.componentTag,
    sourcePath: target.sourcePath,
    scopeSha256: sha256(JSON.stringify(target.metadata ?? null)),
    commitSha: task.commitSha,
    sourceSha256: sha256(source),
    currentHtmlSha256: sha256(currentHtml),
    desiredHtmlSha256: sha256(nextHtml),
  };
  if (wixEmbedEffectToken(effect) !== prepared.token) {
    throw new WixEmbedDeliveryError("The Wix target, binding, source, or live embed changed after review; plan it again", 409);
  }
  const dir = path.join("/tmp/opencode", `embed-${task.id}`);
  await mkdir(dir, { recursive: true });
  const htmlFile = path.join(dir, `${target.componentTag}.html`);
  await writeFile(htmlFile, nextHtml, "utf8");
  const claimed = await db.agentTask.updateMany({
    where: { id: task.id, status: "COMMITTED", actionRevision: task.actionRevision },
    data: { status: "PUBLISHING" },
  });
  if (claimed.count !== 1) throw new WixEmbedDeliveryError("Another executor changed this task; refresh and reconcile before applying", 409);
  try {
    await addAgentArtifact(task.id, {
      kind: "embed_apply_started",
      content: JSON.stringify({ token: prepared.token, effect, startedAt: new Date().toISOString() }),
    });
  } catch (error) {
    await db.agentTask.updateMany({ where: { id: task.id, status: "PUBLISHING" }, data: { status: "COMMITTED" } });
    throw error;
  }
  let receipt: unknown;
  try {
    receipt = await updateBridgeSnippet(delivery.bridgeAlias, target.snippetId!, htmlFile, true);
  } catch (error) {
    try {
      const observed = await readBridgeSnippet(delivery.bridgeAlias, target.snippetId!) as { snippet?: { embedData?: { html?: string } } };
      if (wixEmbedReadbackMatches(observed.snippet?.embedData?.html ?? "", effect.desiredHtmlSha256)) {
        receipt = { status: "complete", reconciledBy: "readback", desiredSha256: effect.desiredHtmlSha256 };
      }
    } catch { /* preserve the uncertain outcome below */ }
    if (!receipt) receipt = { status: "unknown", error: error instanceof Error ? error.message : "Unknown bridge error" };
  }
  const receiptStatus = (receipt && typeof receipt === "object" ? (receipt as Record<string, unknown>).status : null);
  let readbackMatches = false;
  try {
    const observed = await readBridgeSnippet(delivery.bridgeAlias, target.snippetId!) as { snippet?: { embedData?: { html?: string } } };
    readbackMatches = wixEmbedReadbackMatches(observed.snippet?.embedData?.html ?? "", effect.desiredHtmlSha256);
  } catch { /* an unreadable outcome remains unknown */ }
  if (readbackMatches && receiptStatus !== "complete") {
    receipt = { status: "complete", reconciledBy: "readback", bridgeReceipt: receipt, desiredSha256: effect.desiredHtmlSha256 };
  }
  if (!readbackMatches || (receipt as { status?: unknown } | null)?.status !== "complete") {
    await addAgentArtifact(task.id, {
      kind: receiptStatus === "partial" ? "embed_partial_receipt" : "embed_apply_unknown",
      content: JSON.stringify({ token: prepared.token, effect, receipt }),
    });
    throw new WixEmbedDeliveryError("Bridge did not confirm a complete embed effect; reconcile before retrying", 502);
  }
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
  const source = task.commitSha ? await reviewedSource(task, target.sourcePath!) : await readFile(sourcePath, "utf8");
  const snippet = await readBridgeSnippet(delivery.bridgeAlias, target.snippetId!) as {
    snippet?: { embedData?: { html?: string } };
  };
  const currentHtml = snippet.snippet?.embedData?.html ?? "";
  const expectedHtml = buildPacket(currentHtml, target, source);
  const plans = await db.agentTaskArtifact.findMany({
    where: { taskId, kind: "embed_plan" }, orderBy: { createdAt: "desc" }, take: 1,
    select: { content: true },
  });
  let plannedHash: string | null = null;
  if (plans[0]?.content) {
    try {
      const plan = JSON.parse(plans[0].content) as { target?: string; effect?: { desiredHtmlSha256?: string } };
      if (plan.target === target.key) plannedHash = plan.effect?.desiredHtmlSha256 ?? null;
    } catch { /* A malformed plan is not reconciliation evidence. */ }
  }
  const result = {
    verified: plannedHash ? sha256(currentHtml) === plannedHash : currentHtml === expectedHtml,
    target: target.key,
    snippetId: target.snippetId,
    componentTag: target.componentTag,
    expectedSha256: plannedHash ?? sha256(expectedHtml),
    actualSha256: createHash("sha256").update(currentHtml).digest("hex"),
  };
  await addAgentArtifact(task.id, { kind: "embed_verify", content: JSON.stringify(result, null, 2) });
  if (result.verified) {
    const attempts = await db.agentTaskArtifact.findMany({
      where: { taskId, kind: { in: ["embed_apply_started", "embed_receipt"] } },
      orderBy: { createdAt: "desc" }, take: 1, select: { kind: true, content: true },
    });
    const reconciledEffect = attempts[0]?.content ? JSON.parse(attempts[0].content) as Record<string, unknown> : {};
    await addAgentArtifact(task.id, { kind: "embed_reconcile", content: JSON.stringify({
      target: target.key, snippetId: target.snippetId, sha256: result.actualSha256,
      outcome: attempts[0]?.kind === "embed_apply_started" ? "applied_by_readback" : "verified",
      reconciledAt: new Date().toISOString(),
    }) });
    if (attempts[0]?.kind === "embed_apply_started" && task.status === "PUBLISHING") {
      const updated = await db.agentTask.update({ where: { id: task.id }, data: {
        status: "PUBLISHED", publishedUrl: target.route ?? null, completedAt: new Date(),
      } });
      if (task.actionId) {
        await db.delivery.create({ data: {
          actionId: task.actionId, platform: "wix_embed", externalId: target.snippetId!, status: "PUBLISHED",
          payload: JSON.parse(JSON.stringify({ target: target.key, reconciled: true, effect: reconciledEffect })), verifiedAt: new Date(),
        } });
      }
      return { ...result, reconciled: true, task: updated };
    }
  }
  return result;
}
