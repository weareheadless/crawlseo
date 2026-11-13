/**
 * Wave 6 checklist, executable.
 *
 * The ledger (docs/wave6-cleanup-ledger.md) is prose; this turns the three steps
 * into a status report with evidence, so drift shows up as a failing check rather
 * than a stale document.
 *
 *   npx tsx scripts/wave6-status.ts           # report
 *   npx tsx scripts/wave6-status.ts --strict  # exit non-zero unless every step is complete
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { FROZEN_CREATES, FROZEN_NOW } from "../lib/funnel/legacy-freeze";
import { auditLegacyWriters, scheduledWriters, writersByTable } from "./legacy-writer-audit";
import { watchLegacyWrites } from "./legacy-write-watch";

export type CheckStatus = "complete" | "partial" | "open";

export type Check = {
  step: 1 | 2 | 3;
  name: string;
  status: CheckStatus;
  detail: string;
};

export type Wave6Status = {
  checks: Check[];
  /** Work the checklist surfaces but does not contain, with its own owner. */
  blockedBy: Array<{ item: string; reason: string }>;
  summary: { complete: number; partial: number; open: number };
};

const DELETED_ITEMS = [
  "lib/research/crawl-actions.ts",
  "lib/research/seo-actions.ts",
  "lib/research/keyword-actions.ts",
  "lib/dataforseo/prelaunch-actions.ts",
  "lib/pipeline/lineage.ts",
  "lib/pipeline/lineage-types.ts",
  "scripts/sync-seo-actions.ts",
  "lib/crawler/technical-actions.ts",
];

/** Factories still gated, with the exact consumer that keeps them alive. */
const GATED_FACTORIES: Array<{ file: string; blockedBy: string }> = [];

/** Read the flag from the live pm2 processes, not from `.env`. */
export function runningProcessFreezeState(pm2Pids = "/home/admin/.pm2/pids"): Array<{ app: string; pid: number | null; strict: boolean }> {
  const apps = [
    { app: "web", file: "crawlseo-6.pid" },
    { app: "worker", file: "crawlseo-worker-8.pid" },
  ];
  return apps.map(({ app, file }) => {
    try {
      const pid = Number(readFileSync(path.join(pm2Pids, file), "utf8").trim());
      if (!pid) return { app, pid: null, strict: false };
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      return { app, pid, strict: environ.split("\0").includes("CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict") };
    } catch {
      return { app, pid: null, strict: false };
    }
  });
}

export async function wave6Status(db: PrismaClient, opts: { root?: string; hours?: number } = {}): Promise<Wave6Status> {
  const root = opts.root ?? process.cwd();
  const exists = (relative: string) => existsSync(path.join(root, relative));
  const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

  const checks: Check[] = [];

  // Step 1 — legacy routes removed, with redirects keeping their URLs alive.
  const removedRoutes = [
    "content-studio",
    "legacy-work",
    "legacy-opportunities",
    "actions",
    "findings",
    "results",
    "research",
    "intelligence",
  ];
  const siteRoutes = "app/(dashboard)/sites/[siteId]";
  const stillOnDisk = removedRoutes.filter((route) => exists(`${siteRoutes}/${route}`));
  const config = read("next.config.ts");
  const redirected = removedRoutes.filter((route) => config.includes(`/sites/:siteId/${route}`));
  const navClean = !read("components/layout/sidebar-nav.tsx").includes("legacy-work");
  checks.push({
    step: 1,
    name: "legacy routes removed and redirected",
    status: stillOnDisk.length === 0 && redirected.length === removedRoutes.length && navClean ? "complete" : "open",
    detail: `${stillOnDisk.length === 0 ? "all removed" : `NOT removed: [${stillOnDisk.join(", ")}]`}; ${redirected.length}/${removedRoutes.length} redirected; nav ${navClean ? "clean" : "still lists legacy"}`,
  });

  // Step 2 — freeze flipped, and what it can honestly cover.
  // `.env` is not the same thing as the running process: a release without a
  // .env, or a start script that never sources one, leaves the flag off in the
  // process that actually writes. That happened, so the check reads /proc.
  const strict = process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE === "strict";
  const processFlags = runningProcessFreezeState();
  const findings = await auditLegacyWriters(root);
  const scheduled = await scheduledWriters(findings, root);
  const scheduledByTable = writersByTable(scheduled);
  // A table whose creates are blocked cannot grow even though code could try;
  // those are reported separately so "still growing" means what it says.
  const createsAttempted = Object.entries(scheduledByTable)
    .filter(([, writers]) => writers.some((writer) => writer.operation === "create"))
    .map(([table]) => table);
  const createBlocked = createsAttempted.filter((table) => (FROZEN_CREATES as readonly string[]).includes(table));
  // The plan keeps ResearchRun/ResearchFinding as the spine's own run and finding
  // models (spine plan §4), so they are not legacy tables and must not be counted
  // as "legacy coverage" debt. The families DS-02 replaces are.
  const SPINE_MODELS = new Set(["researchRun", "researchFinding"]);
  // The prelaunch idempotency ledger is written by the live request endpoint on
  // purpose (lib/funnel/legacy-freeze.ts), so it is not a run family awaiting a
  // cutover. Counting it as coverage debt would ask for work the plan forbids.
  const LEDGER_MODELS = new Set(["prelaunchResearchRequest"]);
  const stillGrowing = createsAttempted.filter(
    (table) =>
      !(FROZEN_CREATES as readonly string[]).includes(table) &&
      !SPINE_MODELS.has(table) &&
      !LEDGER_MODELS.has(table)
  );
  const spineStillGrowing = createsAttempted.filter((table) => SPINE_MODELS.has(table));
  const ledgerStillGrowing = createsAttempted.filter((table) => LEDGER_MODELS.has(table));
  const watch = await watchLegacyWrites(db, { hours: opts.hours ?? 3 });

  checks.push({
    step: 2,
    name: "strict freeze flipped",
    status: strict ? "complete" : "open",
    detail: strict ? "CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict" : "freeze is off",
  });
  checks.push({
    step: 2,
    name: "freeze present in the running processes",
    status: processFlags.every((entry) => entry.strict) ? "complete" : "open",
    detail: processFlags
      .map((entry) => `${entry.app}${entry.pid ? ` (pid ${entry.pid})` : ""}: ${entry.pid ? (entry.strict ? "strict" : "flag absent") : "not running"}`)
      .join("; "),
  });
  checks.push({
    step: 2,
    name: "freeze covers every proven-retired table",
    status: stillGrowing.length === 0 ? "complete" : "partial",
    detail:
      stillGrowing.length === 0
        ? `no legacy table grows from a scheduled job; fully frozen: [${FROZEN_NOW.join(", ")}], creates blocked: [${FROZEN_CREATES.join(", ")}]`
        : `creates blocked on [${createBlocked.join(", ") || "none"}]; legacy families still growing: [${stillGrowing.join(", ")}] (DS-02, docs/ds-02-run-unification.md)${spineStillGrowing.length ? `; spine models, not legacy: [${spineStillGrowing.join(", ")}]` : ""}${ledgerStillGrowing.length ? `; intentional ledger: [${ledgerStillGrowing.join(", ")}]` : ""}`,
  });
  checks.push({
    step: 2,
    name: "nothing legacy written in the observation window",
    // An out-of-band crawl matters for funnel freshness, not for this step: it
    // does not write a legacy table. Keep it visible without failing the check on
    // something the freeze cannot control.
    status: watch.legacyCreates.length === 0 ? "complete" : "open",
    detail:
      watch.legacyCreates.length === 0
        ? `0 legacy rows over ${watch.windowHours}h${watch.outOfBandCrawls > 0 ? `; ${watch.outOfBandCrawls} out-of-band crawl(s) noted (job queue bypassed)` : ""}`
        : `${watch.legacyCreates.map((row) => `${row.table}:${row.created}`).join(", ")}; out-of-band crawls ${watch.outOfBandCrawls}`,
  });

  // Step 3 — deletions and the reversible table drop.
  const remaining = DELETED_ITEMS.filter((item) => exists(item));
  const gatedPresent = GATED_FACTORIES.filter((entry) => exists(entry.file));
  checks.push({
    step: 3,
    name: "gated items deleted",
    status: remaining.length === 0 ? (gatedPresent.length === 0 ? "complete" : "partial") : "open",
    detail:
      remaining.length > 0
        ? `came back: ${remaining.join(", ")}`
        : gatedPresent.length === 0
          ? `${DELETED_ITEMS.length} items deleted`
          : `${DELETED_ITEMS.length} deleted; ${gatedPresent.length} still gated: ${gatedPresent.map((entry) => entry.file).join(", ")}`,
  });
  checks.push({
    step: 3,
    name: "frozen table dropped in a separate reversible migration",
    status:
      !read("prisma/schema.prisma").includes("model RankSnapshot") &&
      exists("prisma/migrations/20261103120000_drop_rank_snapshot/down.sql")
        ? "complete"
        : "open",
    detail: "RankSnapshot removed from the schema; down.sql restores it",
  });

  const summary = {
    complete: checks.filter((check) => check.status === "complete").length,
    partial: checks.filter((check) => check.status === "partial").length,
    open: checks.filter((check) => check.status === "open").length,
  };

  // What the checklist surfaces but does not own. Kept separate so "the three
  // steps are done" and "these tables still receive rows" are both visible and
  // neither is used to imply the other.
  const blockedBy: Wave6Status["blockedBy"] = stillGrowing.map((table) => ({
    item: `${table} still receives creates from a scheduled job`,
    reason: "DS-02 run-family unification — docs/ds-02-run-unification.md",
  }));
  if (exists("lib/dataforseo/article-research.ts")) {
    blockedBy.push({
      item: "article research runner still writes its legacy row",
      reason: "step 4 of DS-02: move idempotency, cap and parent lookups onto ResearchRun, then stop the write",
    });
  }
  return { checks, blockedBy, summary };
}

if (process.argv[1]?.endsWith("wave6-status.ts")) {
  const strict = process.argv.includes("--strict");
  const db = new PrismaClient();
  wave6Status(db)
    .then((status) => {
      for (const check of status.checks) {
        process.stdout.write(`[${check.status.toUpperCase().padEnd(8)}] step ${check.step} · ${check.name}\n            ${check.detail}\n`);
      }
      process.stdout.write(
        `\n${status.summary.complete} complete · ${status.summary.partial} partial · ${status.summary.open} open\n`
      );
      if (status.blockedBy.length > 0) {
        process.stdout.write("\nNot part of these steps, still open:\n");
        for (const entry of status.blockedBy) {
          process.stdout.write(`  - ${entry.item}\n    ${entry.reason}\n`);
        }
      }
      if (strict && (status.summary.partial > 0 || status.summary.open > 0)) process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
