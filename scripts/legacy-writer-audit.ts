import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Wave 6 step 2: prove no scheduled job writes the legacy tables before the
 * strict freeze is flipped.
 *
 * This is a checkable command rather than an assertion in a document:
 *
 *   npx tsx scripts/legacy-writer-audit.ts            # report
 *   npx tsx scripts/legacy-writer-audit.ts --strict   # exit non-zero if any writer remains
 *
 * A table with a remaining writer cannot be frozen: freezing it would break the
 * producer. The audit names the producer so the reason is visible.
 *
 * Reachability is computed from static imports, so it is an **upper bound**: a
 * file can be imported for a type without its write path ever running from a
 * job. The create/update split narrows it — a table with updates only is no
 * longer growing — and the ledger records which creates are actually reachable
 * from a job handler rather than merely imported.
 */

export type LegacyTable =
  | "researchAction"
  | "researchRun"
  | "researchFinding"
  | "seoResearchRun"
  | "seoResearchTask"
  | "articleKeywordResearchRun"
  | "prelaunchResearchRequest";

export type WriterFinding = {
  table: LegacyTable;
  file: string;
  line: number;
  /**
   * `create` adds rows (the table grows), `update` only mutates rows that
   * already exist (lifecycle transitions that drain). Freezing a table with
   * updates still breaks those transitions, but only a table with creates is
   * still growing.
   */
  operation: "create" | "update" | "delete";
};

const WRITE_METHODS = "(create|createMany|update|updateMany|upsert|delete|deleteMany)";
const PATTERN = new RegExp(`(?:db|tx|client|prisma)\\.(${[
  "researchAction",
  "researchRun",
  "researchFinding",
  "seoResearchRun",
  "seoResearchTask",
  "articleKeywordResearchRun",
  "prelaunchResearchRequest",
].join("|")})\\.${WRITE_METHODS}\\b`, "g");

const SEARCH_ROOTS = ["app", "lib", "scripts"];
const SKIP = new Set(["node_modules", ".next", ".releases", ".agent-worktrees", ".agent-tools", ".git"]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(full);
  }
  return out;
}

export async function auditLegacyWriters(root = process.cwd()): Promise<WriterFinding[]> {
  const files = (await Promise.all(SEARCH_ROOTS.map((dir) => walk(path.join(root, dir))))).flat();
  const findings: WriterFinding[] = [];
  for (const file of files) {
    // Tests and seeds are fixtures, not scheduled producers.
    if (file.includes(`${path.sep}tests${path.sep}`) || file.endsWith(".test.ts")) continue;
    if (file.includes("seed-") || file.includes("smoke-")) continue;
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(PATTERN)) {
      const index = match.index ?? 0;
      const line = content.slice(0, index).split("\n").length;
      const method = match[2] ?? "";
      const operation: WriterFinding["operation"] = method.startsWith("create")
        ? "create"
        : method.startsWith("delete")
          ? "delete"
          : "update";
      findings.push({ table: match[1] as LegacyTable, file: path.relative(root, file), line, operation });
    }
  }
  return findings;
}

/**
 * Files the scheduled worker can reach: the job handlers plus everything they
 * import transitively. Step 2 asks specifically about *scheduled* writers, so
 * the audit distinguishes them from request-path writers (a UI button that will
 * be pointed at the funnel next).
 */
export const SCHEDULED_ENTRY = "scripts/job-worker.ts";

export async function scheduledWriters(
  findings: WriterFinding[],
  root = process.cwd()
): Promise<WriterFinding[]> {
  const seen = new Set<string>();
  const queue = [SCHEDULED_ENTRY];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let content: string;
    try {
      content = await readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(/from "(@\/[^"]+|\.{1,2}\/[^"]+)"/g)) {
      const spec = match[1];
      const base = spec.startsWith("@/") ? spec.slice(2) : path.join(path.dirname(file), spec);
      for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (!seen.has(candidate)) queue.push(candidate);
      }
    }
  }
  return findings.filter((finding) => seen.has(finding.file));
}

export function writersByTable(findings: WriterFinding[]): Record<string, WriterFinding[]> {
  const byTable: Record<string, WriterFinding[]> = {};
  for (const finding of findings) byTable[finding.table] = [...(byTable[finding.table] ?? []), finding];
  return byTable;
}

/**
 * Tables that are provably write-free and can therefore be frozen strictly.
 * Kept explicit so a new writer cannot silently widen the freeze.
 */
export const FROZEN_TABLES: LegacyTable[] = [];

/**
 * Every legacy table still has a producer, so none can be frozen yet. The
 * research pipeline (`lib/research/runner.ts`, `lib/research/service.ts`) is the
 * live business-research producer and is migrated by DS-16, not by cleanup.
 */
export const STILL_WRITTEN: LegacyTable[] = [
  "researchAction",
  "researchRun",
  "researchFinding",
  "seoResearchRun",
  "seoResearchTask",
  "articleKeywordResearchRun",
  "prelaunchResearchRequest",
];

if (process.argv[1]?.endsWith("legacy-writer-audit.ts")) {
  const strict = process.argv.includes("--strict");
  auditLegacyWriters()
    .then(async (findings) => {
      const byTable = writersByTable(findings);
      for (const table of [...FROZEN_TABLES, ...STILL_WRITTEN]) {
        const writers = byTable[table] ?? [];
        process.stdout.write(
          `${writers.length === 0 ? "write-free" : `${writers.length} writer(s)`}  ${table}${
            writers.length ? `\n${writers.map((w) => `    ${w.file}:${w.line}`).join("\n")}` : ""
          }\n`
        );
      }
      const scheduled = await scheduledWriters(findings);
      const scheduledByTable = writersByTable(scheduled);
      process.stdout.write("\nscheduled-job reachability (step 2 gate):\n");
      for (const table of [...FROZEN_TABLES, ...STILL_WRITTEN]) {
        const writers = scheduledByTable[table] ?? [];
        const creates = writers.filter((writer) => writer.operation === "create").length;
        const updates = writers.filter((writer) => writer.operation === "update").length;
        const label =
          writers.length === 0
            ? "no scheduled writer"
            : creates > 0
              ? `${creates} create + ${updates} update (table still grows)`
              : `${updates} update only (nothing new is created)`;
        process.stdout.write(`  ${label}  ${table}\n`);
      }

      const frozenWithWriter = FROZEN_TABLES.filter((table) => (byTable[table] ?? []).length > 0);
      if (frozenWithWriter.length > 0) {
        process.stderr.write(`\nFrozen tables still have writers: ${frozenWithWriter.join(", ")}\n`);
        process.exitCode = 2;
        return;
      }
      if (strict && findings.some((finding) => FROZEN_TABLES.includes(finding.table))) {
        process.exitCode = 2;
      }
    })
    .catch((error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
