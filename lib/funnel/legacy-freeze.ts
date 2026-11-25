import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

/**
 * The **audit list**: every table the retired funnel spine owned.
 *
 * This is not the freeze set. The freeze set is `FROZEN_NOW` and
 * `FROZEN_CREATES` below, both empty, because every table here still has a live
 * writer. Keeping the two apart is the fix for a real error: this list was read as
 * "the tables we freeze", which is how a cutover flag would have been enabled over
 * ten tables that production still writes.
 *
 * `tests/legacy-freeze-writers.test.ts` asserts that no table in the freeze sets has
 * a live writer, and reports which audit-list tables are still being written, so the
 * next person to consider freezing a table sees the answer instead of the intent.
 */
export const FROZEN_FUNNEL_MODELS = [
  "researchRun",
  "researchSource",
  "researchSourceIdentity",
  "researchDispatchClaim",
  "researchFinding",
  "researchAction",
  "seoResearchRun",
  "seoResearchTask",
  "prelaunchResearchRequest",
  "articleKeywordResearchRun",
  "rankSnapshot",
] as const;

export type FrozenFunnelModel = (typeof FROZEN_FUNNEL_MODELS)[number];

/**
 * Tables proven to have **no writer at all** (scripts/legacy-writer-audit.ts), so
 * the strict freeze may cover them today.
 *
 * Empty right now, and that is the honest state: `rankSnapshot` was the only
 * proven-write-free table and it has been dropped (its data moved to the
 * evidence store). The mechanism stays armed — the next table joins this list
 * when its migration lands, and `prelaunchResearchRequest` stays out because the
 * paid prelaunch request endpoint still writes it. Freezing is per-table on
 * purpose: freezing a table whose producer still runs breaks that producer.
 */
export const FROZEN_NOW: readonly FrozenFunnelModel[] = [] as const;

/**
 * Tables whose **creates** are blocked while updates are still allowed.
 *
 * This is the honest middle state for a table that is no longer produced by the
 * funnel but may still have work in flight: nothing new may be added, and any
 * accidental (or forgotten) writer fails loudly with its stack, while lifecycle
 * transitions on existing rows can still complete.
 *
 * **Empty, and it has to stay empty until the producers are gone.** It held
 * `researchAction`, and that was wrong: `lib/research/runner.ts` (reached from
 * `scripts/job-worker.ts`) and `lib/research/question-coverage.ts` both call
 * `createResearchAction`, which writes the table. Enabling
 * `CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict` as `lib/db.ts` instructs would have made
 * every one of those creates throw. Measured 2026-11-25: 9 live modules write
 * `researchAction`.
 *
 * The lesson is in `FROZEN_FUNNEL_MODELS` below: a list of names is not a check.
 * `tests/legacy-freeze-writers.test.ts` now fails when a frozen table has a live
 * writer, so this cannot be got wrong quietly again.
 */
export const FROZEN_CREATES: readonly string[] = [] as const;

/** Tables the strict freeze covers in full: proven-retired only. */
export function frozenModelsFor(strict: boolean): readonly string[] {
  return strict ? FROZEN_NOW : [];
}

/** Tables whose creates are blocked (updates allowed). */
export function createBlockedModelsFor(strict: boolean): readonly string[] {
  return strict ? FROZEN_CREATES : [];
}

export class LegacyFunnelWriteError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`legacy funnel table "${model}" is frozen read-only (seo-funnel-spine-plan §6); write rejected`);
    this.name = "LegacyFunnelWriteError";
    this.model = model;
  }
}

export function assertLegacyFunnelModelNotFrozen(model: string, strict = true): void {
  if (strict && (FROZEN_NOW as readonly string[]).includes(model)) {
    throw new LegacyFunnelWriteError(model);
  }
}

/** Creates are blocked on a frozen-creates table; updates still pass. */
export function assertLegacyCreateAllowed(model: string, strict = true): void {
  if (strict && (FROZEN_CREATES as readonly string[]).includes(model)) {
    throw new LegacyFunnelWriteError(model);
  }
}

/**
 * Prisma client proxy that makes the frozen legacy funnel tables strictly
 * read-only: any write delegate call on a frozen model throws. Reads pass
 * through untouched, so audits and spend reconciliation keep working.
 */
export function withFrozenLegacyFunnel<T extends PrismaClient>(db: T, strict = true): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const frozen = (frozenModelsFor(strict) as readonly string[]).includes(prop as string);
      const createBlocked = (createBlockedModelsFor(strict) as readonly string[]).includes(prop as string);
      if (typeof prop !== "string" || (!frozen && !createBlocked)) {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return withWriteGuard(prop, value, frozen);
    },
  }) as T;
}

const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

function withWriteGuard(model: string, delegate: unknown, fullyFrozen: boolean): unknown {
  return new Proxy(delegate as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (WRITE_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          if (fullyFrozen) assertLegacyFunnelModelNotFrozen(model, true);
          else if (prop.startsWith("create")) assertLegacyCreateAllowed(model, true);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}
