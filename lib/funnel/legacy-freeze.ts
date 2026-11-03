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
] as const;

export type FrozenFunnelModel = (typeof FROZEN_FUNNEL_MODELS)[number];

export class LegacyFunnelWriteError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`legacy funnel table "${model}" is frozen read-only (seo-funnel-spine-plan §6); write rejected`);
    this.name = "LegacyFunnelWriteError";
    this.model = model;
  }
}

export function assertLegacyFunnelModelNotFrozen(model: string): void {
  if ((FROZEN_FUNNEL_MODELS as readonly string[]).includes(model)) {
    throw new LegacyFunnelWriteError(model);
  }
}

/**
 * Prisma client proxy that makes the frozen legacy funnel tables strictly
 * read-only: any write delegate call on a frozen model throws. Reads pass
 * through untouched, so audits and spend reconciliation keep working.
 */
export function withFrozenLegacyFunnel<T extends PrismaClient>(db: T): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !(FROZEN_FUNNEL_MODELS as readonly string[]).includes(prop)) {
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
          assertLegacyFunnelModelNotFrozen(model);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}
