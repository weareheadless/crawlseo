export const DEFAULT_AEO_CAP = 30;
export const MAX_AEO_CAP = 60;

/** Paid-request count guard; no provider call is permitted when this denies it. */
export function applyCap(requested: number, cap: number, spent: number): { allowed: number; skipped: number } {
  const safeRequested = Math.max(0, Math.floor(Number.isFinite(requested) ? requested : 0));
  const safeCap = Math.max(0, Math.floor(Number.isFinite(cap) ? cap : 0));
  const safeSpent = Math.max(0, Math.floor(Number.isFinite(spent) ? spent : 0));
  const allowed = Math.min(safeRequested, Math.max(0, safeCap - safeSpent));
  return { allowed, skipped: safeRequested - allowed };
}

export function normalizeAeoCap(cap?: number): number {
  return Math.min(MAX_AEO_CAP, Math.max(1, Math.floor(cap ?? DEFAULT_AEO_CAP)));
}
