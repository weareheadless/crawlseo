/**
 * DS-04 collector: performs the paid OnPage crawl and records the response.
 *
 * Split from `dataforseo-onpage-dual-run.ts` on purpose: the harness ingests a
 * recorded response and refuses to call the provider, so the expensive step is
 * explicit and its output can be replayed. This script does the opposite — it is
 * the only place that spends money, and it writes the raw payload to a file the
 * harness can read.
 *
 * OnPage has no `task_get`: results are read from `POST /on_page/pages`.
 *
 *   npx tsx scripts/dataforseo-onpage-collect.ts \
 *     --target susimacdonald.com --start https://www.susimacdonald.com/ \
 *     --pages 30 --out /tmp/opencode/onpage-susi.json [--js] [--resources]
 */

import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

import { decryptCredential } from "@/lib/encryption";

const BASE = "https://api.dataforseo.com/v3";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Args = {
  target: string;
  startUrl: string;
  pages: number;
  out: string;
  enableJavascript: boolean;
  loadResources: boolean;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "js" || name === "resources") {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(name, value);
    index += 1;
  }
  const target = values.get("target");
  const startUrl = values.get("start");
  const out = values.get("out");
  if (!target || !startUrl || !out) {
    throw new Error("--target, --start and --out are required");
  }
  return {
    target,
    startUrl,
    pages: Math.max(1, Math.min(Number(values.get("pages") ?? 30), 100)),
    out,
    enableJavascript: flags.has("js"),
    loadResources: flags.has("resources"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  const credential = await db.providerCredential.findFirstOrThrow({
    where: { provider: "dataforseo", status: "ACTIVE" },
    select: { encryptedLogin: true, encryptedPassword: true },
  });
  const auth =
    "Basic " +
    Buffer.from(
      `${decryptCredential(credential.encryptedLogin)}:${decryptCredential(credential.encryptedPassword)}`
    ).toString("base64");

  const posted = await fetch(`${BASE}/on_page/task_post`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        target: args.target,
        max_crawl_pages: args.pages,
        start_url: args.startUrl,
        enable_javascript: args.enableJavascript,
        load_resources: args.loadResources,
        store_raw_html: false,
        respect_sitemap: true,
        calculate_keywords: false,
      },
    ]),
  });
  const postedJson = (await posted.json()) as {
    status_code?: number;
    tasks?: Array<{ id?: string; status_code?: number; status_message?: string; cost?: number }>;
  };
  const task = postedJson.tasks?.[0];
  if (!task?.id) {
    throw new Error(`task_post failed: ${postedJson.status_code} ${task?.status_message ?? ""}`);
  }
  process.stdout.write(
    `posted ${task.id} cost=$${task.cost ?? 0} (${args.enableJavascript ? "js" : "no js"})\n`
  );

  // Tasks Ready is free; poll it rather than task_get, which does not exist here.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(15000);
    const res = await fetch(`${BASE}/on_page/tasks_ready`, { headers: { Authorization: auth } });
    const json = (await res.json()) as { tasks?: Array<{ result?: Array<{ id?: string }> }> };
    const ids = (json.tasks?.[0]?.result ?? []).map((row) => row.id);
    if (ids.includes(task.id)) {
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error(`crawl ${task.id} did not finish within 15 minutes`);

  const pagesRes = await fetch(`${BASE}/on_page/pages`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify([{ id: task.id, limit: args.pages }]),
  });
  const pagesJson = (await pagesRes.json()) as {
    tasks?: Array<{
      status_code?: number;
      cost?: number;
      datetime?: string;
      result?: Array<{ items?: unknown[]; total_count?: number }>;
    }>;
  };
  const pagesTask = pagesJson.tasks?.[0];
  const items = pagesTask?.result?.[0]?.items ?? [];
  if (items.length === 0) {
    throw new Error(`no pages returned for ${task.id}: ${pagesTask?.status_code ?? "unknown"}`);
  }

  const recorded = {
    id: task.id,
    status: "ok",
    cost: Number(task.cost) || 0,
    datetime: pagesTask?.datetime ?? new Date().toISOString(),
    result: pagesTask?.result ?? [],
  };
  writeFileSync(args.out, JSON.stringify(recorded, null, 1));
  process.stdout.write(
    `recorded ${items.length} pages to ${args.out} cost=$${recorded.cost}\n`
  );
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 400)}\n`);
  process.exitCode = 1;
});
