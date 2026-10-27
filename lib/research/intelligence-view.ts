/** Small presentation helpers shared by the server page and its regression tests. */
export function observedCount(value: unknown): string {
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "Unknown";
}

export function visibilityState(coverage: unknown): "Observed" | "Unknown" {
  return coverage && typeof coverage === "object" && (coverage as { status?: unknown }).status === "observed"
    ? "Observed"
    : "Unknown";
}
