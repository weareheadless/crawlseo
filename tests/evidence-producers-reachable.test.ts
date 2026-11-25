import { readFileSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EVIDENCE_REGISTRY } from "@/lib/funnel/evidence-registry";

/**
 * Every evidence kind names the modules that may write it. Nothing ever checked
 * that those modules are reachable.
 *
 * That gap is how `lib/funnel/cluster-discovery.ts` stayed in the registry long
 * after the topic map took ownership of the demand map: its only caller sat
 * behind a guard, its output was entirely superseded in production, and the
 * registry still listed it as a producer. A declared producer that no entry point
 * can reach is dead code pretending to be a source of truth, and the shape checks
 * cannot see it because a dead module writes the same shape a live one does.
 *
 * This test reads the source tree rather than the module graph, because the
 * question is "is this reachable from something that runs", and a test should not
 * boot the worker to answer it. It asserts the narrow, provable half: a declared
 * producer file exists and something imports it. Whether that importer is itself
 * reachable is a review question, not a regex.
 */

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["lib", "app", "scripts", "components"];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts)$/.test(name)) files.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) walk(path.join(ROOT, dir));
  return files;
}

/** The file a registry producer string points at, relative to the repo root. */
function producerPath(producer: string): string {
  return path.join(ROOT, `${producer}.ts`);
}

describe("the evidence registry's producers are reachable", () => {
  const files = sourceFiles();
  const contents = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
  const declared = Object.entries(EVIDENCE_REGISTRY).flatMap(([kind, spec]) =>
    (spec.producers ?? []).map((producer) => ({ kind, producer }))
  );

  it("has producers to check", () => {
    // A guard on the guard: if the registry shape changes, this test must fail
    // loudly rather than pass over an empty list.
    expect(declared.length).toBeGreaterThan(0);
  });

  it("names a file that exists for every declared producer", () => {
    const missing = declared
      .filter(({ producer }) => !files.includes(producerPath(producer)))
      .map(({ kind, producer }) => `${kind} -> ${producer}`);
    expect(missing).toEqual([]);
  });

  it("has something that imports every declared producer", () => {
    // Two legitimate forms, and both count: the `@/lib/x/y` alias, and a
    // relative `./y` from a file in the same directory — which is how a barrel
    // such as `lib/google/index.ts` re-exports its siblings.
    const isImported = (producer: string): boolean => {
      const target = producerPath(producer);
      const dir = path.dirname(target);
      const base = path.basename(producer);
      return files.some((file) => {
        if (file === target) return false;
        const body = contents.get(file) ?? "";
        if (body.includes(`"@/${producer}"`) || body.includes(`'@/${producer}'`)) return true;
        if (path.dirname(file) !== dir) return false;
        return (
          body.includes(`"./${base}"`) ||
          body.includes(`'./${base}'`) ||
          body.includes(`"./${base}.ts"`) ||
          body.includes(`'./${base}.ts'`)
        );
      });
    };
    const orphans = declared
      .filter(({ producer }) => !isImported(producer))
      .map(({ kind, producer }) => `${kind} -> ${producer}`);
    expect(orphans).toEqual([]);
  });

  it("does not list a producer for a kind that declares none", () => {
    // Every kind either names a producer or states why it has none. An empty
    // list with no reason is the state this whole file exists to prevent.
    const unexplained = Object.entries(EVIDENCE_REGISTRY)
      .filter(([, spec]) => (spec.producers ?? []).length === 0 && !spec.reason?.trim())
      .map(([kind]) => kind);
    expect(unexplained).toEqual([]);
  });
});
