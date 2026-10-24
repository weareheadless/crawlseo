import { execFile } from "node:child_process";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentScreenshot = { url: string; file: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function family(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.slice(0, 2).join("/") || "home";
  } catch {
    return url;
  }
}

export function selectScreenshotUrls(input: {
  route: string | null;
  evidence: unknown;
  limit?: number;
}): string[] {
  const evidence = record(input.evidence);
  const issueType = typeof evidence.issue_type === "string" ? evidence.issue_type : "";
  if (!["MISSING_ALT", "MIXED_CONTENT"].includes(issueType)) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 3, 6));
  const urls = [
    input.route,
    ...(Array.isArray(evidence.urls)
      ? evidence.urls.filter((url): url is string => typeof url === "string")
      : []),
  ].filter((url): url is string => Boolean(url && validUrl(url)));
  const seen = new Set<string>();
  const selected: string[] = [];
  const usedFamilies = new Set<string>();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const key = family(url);
    if (usedFamilies.has(key)) continue;
    usedFamilies.add(key);
    selected.push(url);
    if (selected.length >= limit) return selected;
  }
  for (const url of urls) {
    if (selected.includes(url)) continue;
    selected.push(url);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function chromeExecutable(): Promise<string | null> {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/home/admin/.cache/ms-playwright";
  try {
    const entries = await readdir(root);
    for (const entry of entries.filter((value) => value.startsWith("chromium-")).sort().reverse()) {
      const candidate = path.join(root, entry, "chrome-linux64", "chrome");
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next cached Chromium.
      }
    }
  } catch {
    // No Playwright browser cache.
  }
  return null;
}

export async function captureTaskScreenshots(
  taskId: string,
  urls: string[],
  options: { timeoutMs?: number } = {},
): Promise<AgentScreenshot[]> {
  if (urls.length === 0) return [];
  const chrome = await chromeExecutable();
  if (!chrome) return [];
  const directory = path.join("/tmp/opencode", "agent-screenshots", taskId);
  await mkdir(directory, { recursive: true });
  const screenshots: AgentScreenshot[] = [];
  for (const [index, url] of urls.entries()) {
    const file = path.join(directory, `${index + 1}.png`);
    try {
      await execFileAsync(chrome, [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--window-size=1440,1200",
        "--virtual-time-budget=20000",
        "--disable-blink-features=AutomationControlled",
        "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        `--screenshot=${file}`,
        url,
      ], {
        timeout: options.timeoutMs ?? 90_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const info = await stat(file);
      if (info.size > 0) screenshots.push({ url, file });
    } catch {
      // A screenshot failure must not block the code task.
    }
  }
  return screenshots;
}
