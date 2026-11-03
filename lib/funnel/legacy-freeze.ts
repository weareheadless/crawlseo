import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

/**
 * Legacy funnel tables are frozen read-only at cutover
 * (docs/seo-funnel-spine-plan.md §6). Writes are rejected here at the
 * application layer; the tables remain queryable for audits and spend
 * reconciliation. Nothing is deleted and no data is migrated.
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

/** Tables the strict freeze covers: proven-retired only. */
export function frozenModelsFor(strict: boolean): readonly string[] {
  return strict ? FROZEN_NOW : [];
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

/**
 * Prisma client proxy that makes the frozen legacy funnel tables strictly
 * read-only: any write delegate call on a frozen model throws. Reads pass
 * through untouched, so audits and spend reconciliation keep working.
 */
export function withFrozenLegacyFunnel<T extends PrismaClient>(db: T, strict = true): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !(frozenModelsFor(strict) as readonly string[]).includes(prop)) {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return withWriteGuard(prop, value);
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

function withWriteGuard(model: string, delegate: unknown): unknown {
  return new Proxy(delegate as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (WRITE_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          assertLegacyFunnelModelNotFrozen(model, true);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}
