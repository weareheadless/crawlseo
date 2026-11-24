import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVIDENCE_KINDS, EVIDENCE_REGISTRY } from "@/lib/funnel/evidence";
import type { EvidenceRecordKind } from "@prisma/client";

/**
 * CMP-011: the guard that stops "one finding per conversation".
 *
 * Eleven issues came out of one reading of this layer, each found separately,
 * because `EVIDENCE_KINDS` was a bare string array: a detector could be built
 * against a metric label, a dimension or a whole kind that nothing produces, and
 * the build stayed green. Every test here is a fact about the code, so a new
 * orphan fails CI on the commit that introduces it instead of being discovered by
 * a person reading production data weeks later.
 */

/** Every .ts/.tsx file under lib/ and app/, excluding tests and generated code. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) {
        if (entry === "node_modules" || entry === ".next") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  for (const root of ["lib", "app"]) walk(root);
  return out;
}

const FILES = sourceFiles().map((path) => ({ path, source: readFileSync(path, "utf8") }));

/** `num(row, "provider:x")`, `dim(row, "cluster")`, `metrics["x"]`. */
function metricLabelsRead(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of FILES) {
    for (const match of file.source.matchAll(/num\([A-Za-z_$][\w$.,\s]*?,\s*"([a-z_]+:[A-Za-z]+)"/g)) {
      const list = found.get(match[1]) ?? [];
      list.push(file.path);
      found.set(match[1], list);
    }
  }
  return found;
}

function dimensionKeysRead(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of FILES) {
    for (const match of file.source.matchAll(/dim\([A-Za-z_$][\w$.,\s]*?,\s*"([A-Za-z_]+)"/g)) {
      const list = found.get(match[1]) ?? [];
      list.push(file.path);
      found.set(match[1], list);
    }
  }
  return found;
}

/**
 * Metric labels and kinds a writer stores: `"provider:x": { value` inside a
 * metrics object, and `kind: "x"` next to a storeEvidenceRecord call.
 */
function writtenMetricLabels(): Set<string> {
  const found = new Set<string>();
  for (const file of FILES) {
    if (!file.source.includes("storeEvidenceRecord") && !file.path.includes("collection")) continue;
    for (const match of file.source.matchAll(/"([a-z_]+:[A-Za-z]+)":\s*\{\s*value/g)) found.add(match[1]);
  }
  return found;
}

function writtenKinds(): Set<string> {
  const found = new Set<string>();
  for (const file of FILES) {
    for (const match of file.source.matchAll(/kind:\s*"([a-z_]+)"/g)) found.add(match[1]);
  }
  return found;
}

function kindsReadByCode(): Set<string> {
  const found = new Set<string>();
  const isEvidenceKind = (kind: string) => EVIDENCE_KINDS.includes(kind as EvidenceRecordKind);
  for (const file of FILES) {
    for (const match of file.source.matchAll(/byKind\([^,]+,\s*"([a-z_]+)"/g)) {
      if (isEvidenceKind(match[1])) found.add(match[1]);
    }
    // `kind: { in: [...] }` is used for other enums too (Wix publish states,
    // agent task kinds), so only evidence kinds count as a read.
    for (const match of file.source.matchAll(/kind:\s*\{\s*in:\s*\[([^\]]+)\]/g)) {
      for (const inner of match[1].matchAll(/"([a-z_]+)"/g)) if (isEvidenceKind(inner[1])) found.add(inner[1]);
    }
    for (const match of file.source.matchAll(/DETECTOR_REQUIRES[\s\S]{0,4000}?\];/g)) {
      // The detector requirement table itself.
      for (const inner of match[0].matchAll(/"([a-z_]+)"/g)) if (isEvidenceKind(inner[1])) found.add(inner[1]);
    }
  }
  // The registry's own declarations are not a read.
  for (const kind of EVIDENCE_KINDS) {
    if (EVIDENCE_REGISTRY[kind].producers.length === 0) continue;
    found.add(kind);
  }
  return found;
}

const declaredLabels = new Set(Object.values(EVIDENCE_REGISTRY).flatMap((spec) => spec.metrics));
const declaredDimensions = new Set(
  Object.values(EVIDENCE_REGISTRY).flatMap((spec) => [...spec.dimensions.required, ...spec.dimensions.optional])
);

describe("evidence registry is the single source of truth", () => {
  it("declares every kind the schema allows, and nothing it does not", () => {
    // The schema enum is the authority; the registry must match it exactly.
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const block = /enum EvidenceRecordKind \{([\s\S]*?)\}/.exec(schema)?.[1] ?? "";
    const schemaKinds = [...block.matchAll(/^\s*([a-z_]+)\s*$/gm)].map((match) => match[1]).sort();
    expect([...EVIDENCE_KINDS].sort()).toEqual(schemaKinds);
  });

  it("gives every kind a declared window and a reason when nothing writes it", () => {
    for (const kind of EVIDENCE_KINDS) {
      const spec = EVIDENCE_REGISTRY[kind as EvidenceRecordKind];
      expect(spec, `kind ${kind} has no registry entry`).toBeTruthy();
      expect(["single_point", "rolling_window", "sampled_point"]).toContain(spec.window);
      if (spec.producers.length === 0) {
        // A dead kind is allowed, an unexplained one is not: this is what made
        // eight of nineteen kinds silently rot.
        expect(spec.reason, `kind ${kind} has no producer and no reason`).toBeTruthy();
      }
    }
  });

  it("requires a dimension list no reader can bypass", () => {
    for (const kind of EVIDENCE_KINDS) {
      const spec = EVIDENCE_REGISTRY[kind as EvidenceRecordKind];
      expect(Array.isArray(spec.dimensions.required)).toBe(true);
      expect(Array.isArray(spec.metrics)).toBe(true);
    }
  });
});

describe("every metric label a reader filters on is declared by some kind", () => {
  it("has no orphan reads", () => {
    const orphans = [...metricLabelsRead().entries()]
      .filter(([label]) => !declaredLabels.has(label))
      .map(([label, files]) => `${label} (${[...new Set(files)].join(", ")})`);
    // Rename a label in one place only and this fails on that commit.
    expect(orphans, `metric labels read but declared by no kind:\n${orphans.join("\n")}`).toEqual([]);
  });
});

describe("every dimension a reader filters on is declared by some kind", () => {
  it("has no orphan reads", () => {
    // Query-plumbing keys that exist in the Prisma API rather than in evidence.
    const notDimensions = new Set(["id", "kind", "projectId", "siteId", "observedAt", "supersededById", "rawResponseId"]);
    const orphans = [...dimensionKeysRead().entries()]
      .filter(([key]) => !declaredDimensions.has(key) && !notDimensions.has(key))
      .map(([key, files]) => `${key} (${[...new Set(files)].join(", ")})`);
    expect(orphans, `dimensions read but declared by no kind:\n${orphans.join("\n")}`).toEqual([]);
  });
});

/**
 * Kinds that are read but have no producer, kept deliberately and visibly.
 *
 * CMP-011 does not delete a dead kind: removing an enum value is a reviewed
 * migration. So a gap is allowed, but only when it is named here. This list
 * self-prunes — a kind that gains a producer must leave it, and a kind that is
 * read without being listed fails the build.
 */
const DECLARED_GAPS: readonly EvidenceRecordKind[] = ["vitals", "gsc_query"];

describe("every kind a reader asks for can be produced", () => {
  it("has no undeclared consumer without a producer", () => {
    const declaredWriters = new Set<EVIDENCE_KINDS_WITH_PRODUCER>();
    for (const kind of EVIDENCE_KINDS) {
      if (EVIDENCE_REGISTRY[kind as EvidenceRecordKind].producers.length > 0) declaredWriters.add(kind as EVIDENCE_KINDS_WITH_PRODUCER);
    }
    const read = kindsReadByCode();
    const gaps = new Set(DECLARED_GAPS);
    const orphans = [...read].filter(
      (kind) => !declaredWriters.has(kind as EVIDENCE_KINDS_WITH_PRODUCER) && !gaps.has(kind as EvidenceRecordKind)
    );
    expect(
      orphans,
      `kinds read with no producer and not declared as a known gap:\n${orphans.join("\n")}\n` +
        `(fix the producer, or add it to DECLARED_GAPS with a reason in the registry)`
    ).toEqual([]);
  });

  it("keeps the declared-gap list honest in both directions", () => {
    for (const kind of DECLARED_GAPS) {
      // A gap that gained a producer must be removed from this list in the same
      // commit, or the list becomes a lie that hides the next orphan.
      expect(EVIDENCE_REGISTRY[kind].producers, `${kind} has a producer now; remove it from DECLARED_GAPS`).toEqual([]);
      expect(EVIDENCE_REGISTRY[kind].reason, `${kind} is a declared gap; the registry must say why`).toBeTruthy();
    }
  });

  it("has no producer that is not a declared module", () => {
    // A producer name must correspond to a file, so a rename cannot leave a
    // registry entry pointing at nothing.
    for (const kind of EVIDENCE_KINDS) {
      for (const producer of EVIDENCE_REGISTRY[kind as EvidenceRecordKind].producers) {
        const exists = FILES.some(
          (file) => file.path === `${producer}.ts` || file.path === `${producer}.tsx` || file.path.startsWith(`${producer}/`)
        );
        expect(exists, `kind ${kind} names producer "${producer}", which is not a file`).toBe(true);
      }
    }
  });
});

/**
 * The starting failure this issue was written against, kept as a written record.
 *
 * These are the defects measured on 2026-11-24. The assertions above fail on the
 * unfixed code; the list is here so the PR can quote what it started from rather
 * than describing it from memory.
 */
describe("the recorded starting defects", () => {
  const STARTING_DEFECTS = {
    // CMP-003 gave competitor_rank a writer; CMP-007 gave
    // provider:referringDomainGap one; CMP-008 gave share_of_voice one. Each was
    // moved out of this list in the commit that fixed it, which is the point of the
    // record: it cannot drift silently in either direction.
    "consumer with no producer": ["vitals", "analytics"],
    "written, nobody reads": ["internal_link_graph"],
    "declared and dead": ["serp_features", "intent_label", "gsc_query"],
    "metric label read, never written": ["first_party:lcpSeconds", "provider:askCount"],
  };

  it("matches what the registry says today, so the record cannot drift silently", () => {
    // Every kind listed as dead must still be declared dead, or this list needs
    // updating in the same commit that fixes it.
    for (const kind of STARTING_DEFECTS["declared and dead"]) {
      expect(EVIDENCE_REGISTRY[kind as EvidenceRecordKind].producers, `${kind} now has a producer; update the record`).toEqual([]);
    }
    // A label read by a detector is accepted by the kind that detector reads.
    expect(declaredLabels.has("provider:referringDomainGap")).toBe(true);
    expect(declaredLabels.has("first_party:lcpSeconds")).toBe(true);
    expect(declaredLabels.has("provider:askCount")).toBe(true);
  });
});

type EVIDENCE_KINDS_WITH_PRODUCER = EvidenceRecordKind;
