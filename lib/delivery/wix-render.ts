import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
 *
 * Some of the sites' own pages mount a component late (their packet loads the
 * source from the CDN after the document), so a caller that needs the visible
 * copy passes a longer budget than the delivery placement check does.
 */
export async function renderPageDom(url: string, timeoutMs = 90_000, virtualTimeBudgetMs = 20_000): Promise<string | null> {
  const chrome = await chromeExecutable();
  if (!chrome) return null;
  try {
    const { stdout } = await execFileAsync(chrome, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--virtual-time-budget=${Math.max(5_000, virtualTimeBudgetMs)}`,
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


type CdpTarget = { type?: string; webSocketDebuggerUrl?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The page's visible copy, including text a site component renders into its
 * own shadow root.
 *
 * `--dump-dom` serialises the light DOM only, so a page whose body is a custom
 * element comes back empty even though a visitor reads it. Chrome DevTools
 * Protocol runs the page and every shadow root is walked for its leaf text.
 */
export async function renderPageText(
  url: string,
  options: { timeoutMs?: number; settleMs?: number; loadWaitMs?: number } = {},
): Promise<string | null> {
  const chrome = await chromeExecutable();
  if (!chrome) return null;
  const timeoutMs = Math.max(10_000, options.timeoutMs ?? 60_000);
  const settleMs = Math.max(0, options.settleMs ?? 4_000);
  const loadWaitMs = Math.max(1_000, options.loadWaitMs ?? 20_000);
  const port = 9_400 + Math.floor(Math.random() * 500);
  const profile = await mkdtemp(path.join(os.tmpdir(), "crawlseo-cdp-"));
  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });

  let socket: WebSocket | null = null;
  const deadline = Date.now() + timeoutMs;
  try {
    let wsUrl: string | null = null;
    while (!wsUrl && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = (await response.json()) as CdpTarget[];
        wsUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl ?? null;
      } catch {
        // The debugger is not listening yet.
      }
      if (!wsUrl) await sleep(200);
    }
    if (!wsUrl) return null;

    socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });

    let sequence = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const waiters: Array<{ method: string; resolve: (params: unknown) => void }> = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      if (message.id != null && pending.has(message.id)) {
        const entry = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message ?? "CDP call failed"));
        else entry.resolve(message.result);
        return;
      }
      for (const waiter of [...waiters]) {
        if (waiter.method !== message.method) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message.params);
      }
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket!.send(JSON.stringify({ id, method, params }));
      });
    const waitFor = (method: string) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, loadWaitMs);
        waiters.push({ method, resolve: () => { clearTimeout(timer); resolve(); } });
      });

    await send("Page.enable");
    const loaded = waitFor("Page.loadEventFired");
    await send("Page.navigate", { url });
    await loaded;
    if (settleMs) await sleep(settleMs);

    // Leaf text of the document and of every shadow root. Script, style and
    // template bodies are not copy a reader sees.
    const expression = `(() => {
      const parts = [];
      const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG']);
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (skip.has(el.tagName)) continue;
          if (el.shadowRoot) walk(el.shadowRoot);
          const children = [...el.children].filter((child) => !skip.has(child.tagName));
          if (children.length === 0 && el.textContent) parts.push(el.textContent.trim());
        }
      };
      walk(document);
      return parts.filter(Boolean).join('\\n');
    })()`;
    const result = await send("Runtime.evaluate", { expression, returnByValue: true }) as { result?: { value?: unknown } };
    const text = typeof result?.result?.value === "string" ? result.result.value : null;
    return text && text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    try { socket?.close(); } catch { /* already closed */ }
    child.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}
