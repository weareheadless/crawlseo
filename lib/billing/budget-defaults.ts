/**
 * The research budget every tenant has, whether or not someone configured one.
 *
 * A tenant with no allowance used to be a tenant with no limit on one path
 * (the monthly bundle spent against the per-bundle cap only) and no spending at
 * all on the other (the connector refused with 409). Neither is a policy: an
 * unset field is an unconfigured field, not a decision to spend or to stop.
 *
 * The defaults are deliberately small. One dollar a month covers a monthly
 * DataForSEO bundle at the default caps (about $0.10) with room to retry, and
 * ten cents per operation matches every tenant that has been configured by
 * hand, so a default tenant behaves like a configured one.
 */

/** $1.00 per calendar month, in micros. */
export const DEFAULT_MONTHLY_RESEARCH_ALLOWANCE_MICROS = BigInt(1_000_000);

/** $0.10 per single paid operation, in micros. */
export const DEFAULT_MAX_RESEARCH_OPERATION_MICROS = BigInt(100_000);

/** The allowance a project actually has: its own, or the default. */
export function effectiveMonthlyAllowance(value: bigint | null | undefined): bigint {
  return value ?? DEFAULT_MONTHLY_RESEARCH_ALLOWANCE_MICROS;
}

/** The per-operation ceiling a project actually has: its own, or the default. */
export function effectiveMaxOperation(value: bigint | null | undefined): bigint {
  return value ?? DEFAULT_MAX_RESEARCH_OPERATION_MICROS;
}

/** True when the project inherits the default rather than setting its own. */
export function usesDefaultAllowance(value: bigint | null | undefined): boolean {
  return value === null || value === undefined;
}
