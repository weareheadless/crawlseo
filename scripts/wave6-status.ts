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
import { LEGACY_ROUTE_DESTINATION } from "../lib/funnel/legacy-routes";
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

  // Step 1 — legacy routes archived.
  const routeSource = read("lib/funnel/legacy-routes.ts");
  const archivedByDefault = routeSource.includes('!== "live"');
  const destinationsDeclared = Object.keys(LEGACY_ROUTE_DESTINATION).length === 5;
  const navClean = !read("components/layout/sidebar-nav.tsx").includes("legacy-work");
  checks.push({
    step: 1,
    name: "legacy routes archived behind a flag",
    status: archivedByDefault && destinationsDeclared && navClean ? "complete" : "open",
    detail: `${archivedByDefault ? "archived by default" : "NOT archived by default"}; ${Object.keys(LEGACY_ROUTE_DESTINATION).length}/5 destinations; nav ${navClean ? "clean" : "still lists legacy"}`,
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
  const stillGrowing = createsAttempted.filter(
    (table) => !(FROZEN_CREATES as readonly string[]).includes(table) && !SPINE_MODELS.has(table)
  );
  const spineStillGrowing = createsAttempted.filter((table) => SPINE_MODELS.has(table));
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
        : `creates blocked on [${createBlocked.join(", ") || "none"}]; legacy families still growing: [${stillGrowing.join(", ")}] (DS-02, docs/ds-02-run-unification.md)${spineStillGrowing.length ? `; spine models, not legacy: [${spineStillGrowing.join(", ")}]` : ""}`,
  });
  checks.push({
    step: 2,
    name: "nothing legacy written in the observation window",
    status: watch.clean ? "complete" : "open",
    detail: watch.clean
      ? `clean over ${watch.windowHours}h (0 legacy rows, 0 out-of-band crawls)`
      : `${watch.legacyCreates.map((row) => `${row.table}:${row.created}`).join(", ") || "none"}; out-of-band crawls ${watch.outOfBandCrawls}`,
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
  return { checks, summary };
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
      if (strict && (status.summary.partial > 0 || status.summary.open > 0)) process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
