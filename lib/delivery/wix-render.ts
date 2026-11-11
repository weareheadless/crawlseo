import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { chromeExecutable } from "@/lib/agent-tasks/screenshots";

const execFileAsync = promisify(execFile);

export async function probeWixRoute(url: string, timeoutMs = 20_000): Promise<number | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "CrawlSEO delivery probe" },
    });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Render the page with a browser so injected content has run. A plain fetch
 * returns Wix's shell, not the mounted content. When no browser is available
 * the result is `null`, which the caller reports as unverified rather than
 * pretending it checked.
 */
export async function renderPageDom(url: string, timeoutMs = 90_000): Promise<string | null> {
  const chrome = await chromeExecutable();
  if (!chrome) return null;
  try {
    const { stdout } = await execFileAsync(chrome, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--virtual-time-budget=20000",
      "--disable-blink-features=AutomationControlled",
      "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "--dump-dom",
      url,
    ], { timeout: timeoutMs, maxBuffer: 24 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}
