import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const BRIDGE_ROOT = process.env.WIX_BRIDGE_ROOT?.trim() || "/home/admin/wix-site-bridge";
const BRIDGE_CLI = path.join(BRIDGE_ROOT, "src", "cli.mjs");

export type WixBridgeOperation = "inspect" | "plan" | "deploy" | "publish" | "release" | "verify" | "read_embed" | "write_embed" | "cms" | "seo_tags";

/** A capability is true only when a bridge explicitly reports it. Unknown bridges fail closed. */
export function negotiateWixBridgeCapabilities(value: unknown): Record<WixBridgeOperation, boolean> {
  const capabilities = (value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).capabilities : null);
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
    cms: operations.cms === true,
    seo_tags: operations.seo_tags === true,
  };
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
  command: "inspect" | "plan" | "deploy" | "release" | "verify" | "snippet" | "update-snippet",
  options: { siteRepo?: string; apply?: boolean; snippetId?: string; htmlFile?: string; preserveScope?: boolean; extraArgs?: string[] } = {},
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
