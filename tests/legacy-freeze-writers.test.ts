import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FROZEN_CREATES,
  FROZEN_FUNNEL_MODELS,
  FROZEN_NOW,
  frozenModelsFor,
  createBlockedModelsFor,
} from "@/lib/funnel/legacy-freeze";

/**
 * A freeze list is a promise that nothing writes the table. This test checks the
 * promise against the source instead of against intent.
 *
 * Why it exists: the list was wrong in a way no one could see. `FROZEN_CREATES`
 * held `researchAction` while `lib/research/runner.ts` and
 * `lib/research/question-coverage.ts` both created rows in it, so enabling
 * `CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict` as `lib/db.ts` instructed would have made
 * every research action write throw. Measured 2026-11-25: nine live modules write
 * that table.
 *
 * A second confusion is guarded too: `FROZEN_FUNNEL_MODELS` is the audit list of
 * every table the retired spine owned, not the set of frozen tables. Reading it as
 * the freeze set is exactly how the cutover looked safe, so the two are asserted to
 * be different things here.
 */

const ROOTS = ["lib", "app", "scripts"];

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) return walk(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Files that call a write delegate on `model`, by source scan. */
function writersOf(model: string, files: string[]): string[] {
  // Prisma delegates are lowercase-identical to the model name.
  const pattern = new RegExp(`\\b${model}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\s*\\(`);
  return files.filter((file) => {
    // The freeze module itself references model names as strings, not as calls.
    if (file.endsWith("legacy-freeze.ts")) return false;
    return pattern.test(readFileSync(file, "utf8"));
  });
}

const files = ROOTS.flatMap((root) => walk(root));

describe("the legacy freeze is honest about its writers", () => {
  it("finds the source at all", () => {
    // A scanner that matched nothing would pass forever.
    expect(files.length).toBeGreaterThan(200);
  });

  it("freezes no table that still has a writer", () => {
    const violations: string[] = [];
    for (const model of [...FROZEN_NOW, ...FROZEN_CREATES]) {
      const writers = writersOf(model, files);
      for (const file of writers) {
        violations.push(`${model} is frozen but ${file} writes it`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("turns the flag into no extra freezing while the lists are empty", () => {
    // The strict flag must not be able to do anything the lists do not describe.
    expect(frozenModelsFor(true)).toEqual([...FROZEN_NOW]);
    expect(createBlockedModelsFor(true)).toEqual([...FROZEN_CREATES]);
  });

  it("keeps the audit list distinct from the freeze set", () => {
    // `FROZEN_FUNNEL_MODELS` is a record of what the spine owned. If someone ever
    // freezes one of them, that is a deliberate act with its writers removed, and
    // it will show up here as a diff rather than as an accident.
    const audit = new Set<string>([...FROZEN_FUNNEL_MODELS]);
    for (const model of [...FROZEN_NOW, ...FROZEN_CREATES]) {
      expect(audit.has(model)).toBe(true);
    }
    // And the audit list is strictly larger: it describes retired tables, not the
    // subset that is safe to freeze today.
    expect(FROZEN_FUNNEL_MODELS.length).toBeGreaterThan(FROZEN_NOW.length);
  });

  it("reports which audit-list tables production still writes", () => {
    // Not an assertion about correctness. It is the information the next person to
    // consider a freeze needs, kept current by the test run rather than by memory.
    const live = FROZEN_FUNNEL_MODELS
      .map((model) => ({ model, writers: writersOf(model, files).length }))
      .filter((row) => row.writers > 0)
      .map((row) => `${row.model}:${row.writers}`);
    // Every table the spine owned is still written today except the ones whose
    // data moved. If this list shrinks, the freeze may be enabled for the rest.
    expect(live.sort()).toMatchInlineSnapshot(`
      [
        "articleKeywordResearchRun:3",
        "prelaunchResearchRequest:1",
        "researchAction:9",
        "researchDispatchClaim:1",
        "researchFinding:2",
        "researchRun:10",
        "researchSource:2",
        "researchSourceIdentity:1",
        "seoResearchRun:1",
        "seoResearchTask:1",
      ]
    `);
  });
});
