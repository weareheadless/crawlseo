/**
 * `llm_mentions` is the one DataForSEO product we deliberately do not run on every
 * refresh.
 *
 * Verified 2026-11-03: a single `llm_mentions` call billed **$0.101** against the
 * account, roughly 168× an `llm_responses` call ($0.0006). The price list quotes
 * it per result, which is why the cost only shows up on the invoice.
 *
 * Owner decision: at most once per calendar month. `llm_responses` is the product
 * for recurring AI-visibility observation; mentions is a monthly market snapshot.
 */

export const LLM_MENTIONS_CADENCE = "monthly" as const;

/** Provider-reported cost of one call, in USD. Used for budget projections. */
export const LLM_MENTIONS_COST_USD = 0.101;

export type MentionsGate =
  | { allowed: true }
  | { allowed: false; reason: string; nextEligibleAt: Date };

/**
 * True at most once per calendar month (UTC). A null `lastRunAt` means the site
 * has never had a snapshot, so the first one is allowed immediately.
 */
export function llmMentionsGate(lastRunAt: Date | null, now: Date): MentionsGate {
  if (!lastRunAt) return { allowed: true };
  const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (lastRunAt.getTime() >= startOfMonth) {
    return {
      allowed: false,
      reason: "llm_mentions already ran this calendar month",
      nextEligibleAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }
  return { allowed: true };
}
