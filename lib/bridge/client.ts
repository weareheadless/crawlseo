import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const BRIDGE_ROOT = process.env.WIX_BRIDGE_ROOT?.trim() || "/home/admin/wix-site-bridge";
const BRIDGE_CLI = path.join(BRIDGE_ROOT, "src", "cli.mjs");

export type WixBridgeOperation = "inspect" | "plan" | "deploy" | "publish" | "release" | "verify" | "read_embed" | "write_embed" | "write_packet" | "disable_embed" | "update_snippet" | "private_editor_revision" | "cms" | "seo_tags";

/** A capability is true only when a bridge explicitly reports it. Unknown bridges fail closed. */
export function negotiateWixBridgeCapabilities(value: unknown): Record<WixBridgeOperation, boolean> {
  const response = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  if (response.contract !== "wix-bridge-generic-v1") return {
    inspect: false, plan: false, deploy: false, publish: false, release: false, verify: false,
    read_embed: false, write_embed: false, write_packet: false, disable_embed: false, update_snippet: false, private_editor_revision: false, cms: false, seo_tags: false,
  };
  const capabilities = response.capabilities;
  const operations = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? capabilities as Record<string, unknown> : {};
  return {
    inspect: operations.inspect === true,
    plan: operations.plan === true,
    deploy: operations.deploy === true,
    publish: operations.publish === true,
    release: operations.release === true,
    verify: operations.verify === true,
    read_embed: operations.read_embed === true,
    write_embed: operations.write_embed === true,
    write_packet: operations.write_packet === true,
    disable_embed: operations.disable_embed === true,
    // Generic v1 advertises whether it can update an existing embed. The host
    // does not promote a host-only command on its own.
    update_snippet: operations.update_snippet === true,
    // The legacy editor revision probe uses a private endpoint, not generic v1.
    private_editor_revision: false,
    cms: operations.cms === true,
    seo_tags: operations.seo_tags === true,
  };
}

/** Run an intelligence command only after a read-only bridge inspection explicitly negotiates it. */
export async function assertNegotiatedWixBridgeOperations(
  alias: string,
  operations: WixBridgeOperation[],
  siteRepo?: string,
): Promise<void> {
  const inspected = await inspectBridgeSite(alias, siteRepo);
  for (const operation of operations) assertWixBridgeCapability(inspected, operation);
}

export function assertWixBridgeCapability(value: unknown, operation: WixBridgeOperation): void {
  if (!negotiateWixBridgeCapabilities(value)[operation]) {
    throw new Error(`Wix bridge capability is unsupported or unnegotiated: ${operation}`);
  }
}

function parseEnvFile(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let entry = line.slice(index + 1).trim();
    if ((entry.startsWith("\"") && entry.endsWith("\"")) || (entry.startsWith("'") && entry.endsWith("'"))) {
      entry = entry.slice(1, -1);
    }
    if (key) env[key] = entry;
  }
  return env;
}

async function bridgeSiteEnv(alias: string): Promise<Record<string, string>> {
  const envPath = path.join(BRIDGE_ROOT, "sites", alias, ".wix-bridge-state", "app.env");
  const contents = await readFile(envPath, "utf8").catch(() => "");
  return parseEnvFile(contents);
}

function runBridge(
  alias: string,
  command: "inspect" | "plan" | "deploy" | "release" | "verify" | "snippet" | "snippets" | "update-snippet" | "create-snippet" | "read-embed" | "write-embed" | "write-packet" | "disable-embed",
  options: {
    siteRepo?: string;
    apply?: boolean;
    snippetId?: string;
    htmlFile?: string;
    preserveScope?: boolean;
    name?: string;
    route?: string;
    allPages?: boolean;
    position?: "HEAD" | "BODY_START" | "BODY_END";
    category?: string;
    loadOnce?: boolean;
    extraArgs?: string[];
  } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = [
      BRIDGE_CLI,
      command,
      "--manifest", path.join(BRIDGE_ROOT, "sites", alias, "site.manifest.json"),
      "--site", alias,
      "--state-dir", path.join(BRIDGE_ROOT, "sites", alias, ".wix-bridge-state"),
      ...(options.siteRepo ? ["--site-repo", options.siteRepo] : []),
      ...(options.snippetId ? ["--snippet", options.snippetId] : []),
      ...(options.htmlFile ? ["--html-file", options.htmlFile] : []),
      ...(options.name ? ["--name", options.name] : []),
      ...(options.route ? ["--route", options.route] : []),
      ...(options.allPages ? ["--all-pages"] : []),
      ...(options.position ? ["--position", options.position] : []),
      ...(options.category ? ["--category", options.category] : []),
      ...(options.loadOnce ? ["--load-once", "true"] : []),
      ...(options.preserveScope ? ["--preserve-scope"] : []),
      ...(options.apply ? ["--apply"] : []),
      ...(options.extraArgs ?? []),
    ];
    void bridgeSiteEnv(alias).then((fileEnv) => {
      execFile(
        process.execPath,
        args,
        {
          cwd: BRIDGE_ROOT,
          env: { ...process.env, ...fileEnv },
          timeout: command === "release" ? 300_000 : 90_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const text = String(stdout || "").trim();
          if (text) {
            try {
              resolve(JSON.parse(text));
              return;
            } catch {
              // Fall through to the command error.
            }
          }
          reject(new Error(String(stderr || error?.message || `Bridge ${command} failed`).slice(0, 1_000)));
        },
      );
    }, reject);
  });
}

export async function inspectBridgeSite(alias: string, siteRepo?: string) {
  return runBridge(alias, "inspect", { siteRepo });
}

export async function planBridgeSite(alias: string, siteRepo: string) {
  return runBridge(alias, "plan", { siteRepo });
}

export function bridgeRoot(): string {
  return BRIDGE_ROOT;
}

export async function deployBridgeSite(alias: string, siteRepo: string, apply = false) {
  return runBridge(alias, "deploy", { siteRepo, apply });
}

export async function releaseBridgeSite(alias: string, siteRepo: string) {
  return runBridge(alias, "release", {
    siteRepo,
    apply: true,
    extraArgs: ["--non-interactive"],
  });
}

export async function verifyBridgeSite(alias: string, siteRepo: string) {
  return runBridge(alias, "verify", { siteRepo });
}

export async function readBridgeSnippet(alias: string, snippetId: string) {
  return runBridge(alias, "snippet", { snippetId });
}

/**
 * Read an embed by id without requiring it in the site manifest. This is the
 * generic read path for embeds CrawlSEO created through the API.
 */
export async function readBridgeEmbed(alias: string, snippetId: string) {
  return runBridge(alias, "read-embed", { snippetId });
}

/** List every custom embed on the site, including ones outside the manifest. */
export async function listBridgeSnippets(alias: string) {
  return runBridge(alias, "snippets");
}

/**
 * Write an embed by id without requiring it in the site manifest. The bridge
 * refuses any embed whose name lacks the CrawlSEO prefix, so a human's embed is
 * never overwritten.
 */
export async function writeBridgeEmbed(
  alias: string,
  snippetId: string,
  htmlFile: string,
  route: string,
  apply = false,
) {
  return runBridge(alias, "write-embed", { snippetId, htmlFile, route, apply });
}

/**
 * Rewrite an early packet. A packet is a HEAD script that registers a
 * component, so it must not be wrapped in the content-embed route guard.
 */
export async function writeBridgePacket(alias: string, snippetId: string, htmlFile: string, apply = false) {
  return runBridge(alias, "write-packet", { snippetId, htmlFile, apply });
}

/**
 * Disable an embed CrawlSEO created. Used when a page moves from the embed
 * lane to a placed custom element: the embed would otherwise replace the page
 * container and hide the element.
 */
export async function disableBridgeEmbed(alias: string, snippetId: string, apply = false) {
  return runBridge(alias, "disable-embed", { snippetId, apply });
}

export async function updateBridgeSnippet(
  alias: string,
  snippetId: string,
  htmlFile: string,
  apply = false,
) {
  return runBridge(alias, "update-snippet", {
    snippetId,
    htmlFile,
    preserveScope: true,
    apply,
  });
}

export type CreateBridgeSnippetInput = {
  name: string;
  htmlFile: string;
  route?: string;
  allPages?: boolean;
  position?: "HEAD" | "BODY_START" | "BODY_END";
  category?: string;
  loadOnce?: boolean;
  apply?: boolean;
};

/**
 * Create a Custom Embed through the documented Wix API. The bridge guards the
 * HTML with the exact route because Wix applies a new embed site-wide and its
 * page filter is read-only. Callers must negotiate `write_embed` first.
 */
export async function createBridgeSnippet(alias: string, input: CreateBridgeSnippetInput) {
  return runBridge(alias, "create-snippet", {
    name: input.name,
    htmlFile: input.htmlFile,
    route: input.route,
    allPages: input.allPages,
    position: input.position ?? "BODY_END",
    category: input.category ?? "FUNCTIONAL",
    loadOnce: input.loadOnce ?? false,
    apply: input.apply ?? false,
  });
}
