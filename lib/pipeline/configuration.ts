export const configurationSectionFields = {
  business: ["topics", "audience", "market", "language", "goals", "services", "competitors", "brandVoice"],
  research: ["providers", "exclusions", "recencyDays", "maxSources"],
  operations: ["cadence", "enabled", "monthlyBudget", "autoDraft", "autoAgent"],
} as const;

export type ConfigurationSection = keyof typeof configurationSectionFields;
export const configurationOwners = Object.fromEntries(
  Object.entries(configurationSectionFields).flatMap(([section, fields]) => fields.map((field) => [field, section])),
) as Record<string, ConfigurationSection>;

export function mergeConstraints(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  return { ...base, ...patch };
}
