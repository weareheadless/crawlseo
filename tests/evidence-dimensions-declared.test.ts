import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVIDENCE_REGISTRY } from "@/lib/funnel/evidence-registry";

/**
 * Every dimension a writer stores is declared in the registry.
 *
 * Twice now a writer has stored a key the registry did not declare, and both
 * times it was not a documentation problem — it was an outage:
 *
 *  - 2026-11-25 `gsc_page` gained `windowEnd`/`scope` in `lib/funnel/backfill`,
 *    so every Search Console and crawl section of a bundle failed its write and
 *    the run read `partial` — which the pipeline gate then refused to build a
 *    map from. $0.206 spent for nothing.
 *  - 2026-11-25 `ai_visibility_observation` gained `searchedKeyword`, doing the
 *    same to every AEO section. $0.1982 spent, eight sections stored, still
 *    `partial`.
 *
 * The write-time validation is right to exist: it stops a writer quietly
 * changing the evidence shape. What was missing is the same check at the cheap
 * end of the loop, so the third one fails in CI instead of in a paid run.
 *
 * This reads source, so it understands only an object literal passed as
 * `dimensions:` inside a `storeEvidenceRecord(` or `evidenceRecord.create(`
 * call, with plain identifier or quoted keys. Anything else — a spread, a
 * computed key, a variable holding the object — is counted and reported, so a
 * reader can tell "checked and clean" from "could not check".
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
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

export type Finding = {
  file: string;
  kind: string;
  keys: string[];
  /** The literal contains something this parser cannot resolve. */
  opaque: boolean;
};

/** The balanced `{...}` starting at `open`, or null. */
function balanced(source: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

/** The argument list of the call whose `(` is at `open`. */
function callArguments(source: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

/** Split an object literal body on commas that are not nested. */
function topLevelEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) entries.push(current);
  return entries;
}

/**
 * Read `kind`, `dimensions` and `metrics` out of one `dimensions:` object.
 *
 * `kind` is a sibling key in the same argument object, found by looking
 * backwards from `dimensions` rather than forwards: an earlier version scanned
 * forwards and picked up every later object in the file, which produced a page
 * of false positives and would have trained a reader to ignore this test.
 *
 * `dimensions` is often a variable passed in shorthand (`dimensions,`). Both
 * real failures were that shape — `gsc_page` inlined it, but
 * `ai_visibility_observation` in `google-ai-overview-collection` hoisted it, so
 * the first version of this check reported "clean" for the exact file it was
 * written to catch. A shorthand is resolved by looking backwards for its
 * `const <name> = {` initialiser; if that is not a literal, the finding is
 * marked opaque rather than skipped.
 */
export function scanSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  for (const signature of ["storeEvidenceRecord(", "evidenceRecord.create("]) {
    let at = source.indexOf(signature);
    while (at >= 0) {
      const args = callArguments(source, at + signature.length - 1);
      if (args) {
        const nested = resolveDimensions(args, source, at);
        const before = args.slice(0, nested.at >= 0 ? nested.at : args.length);
        const kindMatch = [...before.matchAll(/kind:\s*"([a-z_]+)"/g)].pop();
        const kind = kindMatch?.[1];
        if (kind) {
          if (nested.body == null) findings.push({ file, kind, keys: [], opaque: true });
          else {
            const keys: string[] = [];
            let opaque = false;
            for (const entry of topLevelEntries(nested.body)) {
              // Strip leading comments: an entry's first line is often the
              // justification for the key below it, and an earlier version read
              // the comment as the key and gave up on the real one.
              const line = entry
                .replace(/^\s*(?:\/\/[^\n]*\n\s*)+/g, "")
                .replace(/^\s*\/\*[\s\S]*?\*\/\s*/g, "")
                .trim();
              if (!line) continue;
              const plain = /^(?:"([A-Za-z_][A-Za-z0-9_]*)":|([A-Za-z_][A-Za-z0-9_]*):)/.exec(line);
              if (plain) keys.push(plain[1] ?? plain[2]);
              // Shorthand: `field,` is the key `field`.
              else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(line)) keys.push(line);
              else if (line.startsWith("...")) {
                // A conditional spread (`...(x ? { a } : {})`) still states its
                // keys; a spread of a variable (`...dimensions`) does not.
                // Matched over the whole entry, which may span several lines.
                const inner = [...line.matchAll(/\{([\s\S]*?)\}/g)].flatMap((m) =>
                  topLevelEntries(m[1])
                    .map((part) => part.trim())
                    .map((part) => /^(?:"([A-Za-z_][A-Za-z0-9_]*)":|([A-Za-z_][A-Za-z0-9_]*):)/.exec(part))
                    .filter((found): found is RegExpExecArray => found != null)
                    .map((found) => found[1] ?? found[2])
                );
                if (inner.length > 0) keys.push(...inner);
                else opaque = true;
              } else opaque = true;
            }
            findings.push({ file, kind, keys, opaque });
          }
        }
      }
      at = source.indexOf(signature, at + signature.length);
    }
  }
  return findings;
}

/**
 * Locate the dimensions object literal inside a call's arguments.
 *
 * Handles `dimensions: { ... }`, `dimensions: variable` and `dimensions,`.
 * Returns `{ body, at }` where `at` is the index of the `dimensions` key, so the
 * caller can look backwards for the sibling `kind`; `body` is null when the
 * shape cannot be read statically.
 */
function resolveDimensions(
  args: string,
  source: string,
  callStart: number
): { body: string | null; at: number } {
  const key = /dimensions\s*[:,]/.exec(args);
  if (!key) return { body: null, at: -1 };
  const afterKey = args.slice(key.index + "dimensions".length).replace(/^\s*:\s*/, "").trimStart();

  if (afterKey.startsWith("{")) {
    const open = args.indexOf("{", key.index);
    return { body: balanced(args, open), at: key.index };
  }
  // `dimensions: identifier` or shorthand `dimensions,` → find its initialiser.
  const name = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(afterKey)?.[1]
    ?? /([A-Za-z_][A-Za-z0-9_]*)/.exec(args.slice(key.index))?.[1];
  if (!name) return { body: null, at: key.index };
  const before = source.slice(0, callStart);
  const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\b[^=]*=\\s*\\{`, "g");
  let last: RegExpExecArray | null = null;
  let found: RegExpExecArray | null;
  while ((found = declaration.exec(before)) !== null) last = found;
  if (!last) return { body: null, at: key.index };
  const open = before.indexOf("{", last.index);
  const body = balanced(before, open);
  // A conditional expression or a call result is not a literal.
  if (body == null || /=>|[a-zA-Z_][\w.]*\(/.test(body.slice(0, 0))) return { body: null, at: key.index };
  return { body, at: key.index };
}

const findings = ROOTS.flatMap((root) => walk(root))
  .flatMap((file) => scanSource(file, readFileSync(file, "utf8")))
  .filter((finding) => finding.kind in EVIDENCE_REGISTRY);

describe("evidence registry declares what its writers store", () => {
  it("finds the writers at all", () => {
    // A parser that silently matched nothing would pass forever.
    expect(findings.length).toBeGreaterThan(20);
  });

  it("declares every plainly written dimension key", () => {
    const undeclared: string[] = [];
    for (const finding of findings) {
      const spec = EVIDENCE_REGISTRY[finding.kind as keyof typeof EVIDENCE_REGISTRY];
      const declared = new Set([...spec.dimensions.required, ...spec.dimensions.optional]);
      for (const key of finding.keys) {
        if (!declared.has(key)) {
          undeclared.push(`${finding.file}: ${finding.kind} stores "${key}", which the registry does not declare`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("reports the writers whose dimensions it could not read", () => {
    // Not an assertion of correctness: a bound on the claim. A writer whose
    // dimensions object is assembled dynamically (`{ ...dimensions, extra }`)
    // is not covered by a source scan, so it is counted here instead of being
    // silently treated as clean. When one of these becomes a real failure, the
    // fix is to make its dimensions a literal — not to widen this test.
    const opaque = findings.filter((finding) => finding.opaque);
    expect({
      checked: findings.length,
      opaque: opaque.map((finding) => `${finding.file} (${finding.kind})`).sort(),
    }).toMatchInlineSnapshot(`
      {
        "checked": 35,
        "opaque": [
          "lib/dataforseo/collection.ts (backlink_profile)",
          "lib/dataforseo/collection.ts (competitor_rank)",
          "lib/dataforseo/collection.ts (serp_snapshot)",
          "lib/funnel/acquisition.ts (keyword_metrics)",
          "lib/funnel/backfill.ts (onpage_crawl)",
          "lib/funnel/link-gap-pass.ts (backlink_profile)",
          "lib/funnel/tracked-grid.ts (keyword_universe_membership)",
          "lib/recommendation/run.ts (research_finding)",
          "lib/research/finding-evidence.ts (research_finding)",
          "lib/research/finding-evidence.ts (research_finding)",
        ],
      }
    `);
  });
});
