/**
 * Pure projections over a stored business-knowledge fact.
 *
 * A fact is `{ value, provenance, publicationUse, locale? }`. Three readers need
 * different parts of it (the evidence packet needs provenance for citation, the
 * site brief needs status, the tenant report needs "is this usable at all"), so
 * the shape is read in one place instead of being re-parsed per caller.
 */

export function knowledgeFactValue(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const row = value as { value?: unknown };
  if (typeof row.value === "string") return row.value.trim() ? [row.value] : [];
  if (Array.isArray(row.value)) {
    return row.value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
  }
  return [];
}

export function knowledgeFactMeta(value: unknown): {
  sourceUrl: string | null;
  provenanceKind: string;
  provenanceStatus: string;
  publicationUse: string;
} {
  if (!value || typeof value !== "object") {
    return { sourceUrl: null, provenanceKind: "unknown", provenanceStatus: "unknown", publicationUse: "unknown" };
  }
  const row = value as {
    provenance?: { evidenceUri?: unknown; kind?: unknown; status?: unknown };
    publicationUse?: unknown;
  };
  return {
    sourceUrl: typeof row.provenance?.evidenceUri === "string" ? row.provenance.evidenceUri : null,
    provenanceKind: typeof row.provenance?.kind === "string" ? row.provenance.kind : "unknown",
    provenanceStatus: typeof row.provenance?.status === "string" ? row.provenance.status : "unknown",
    publicationUse: typeof row.publicationUse === "string" ? row.publicationUse : "unknown",
  };
}

/**
 * Whether a stored revision carries a business fact the why-leg can cite.
 *
 * A language tag alone is not a business fact. Accepts both the stored shape and
 * the extractor's raw values, because both are asked the same question.
 */
export function hasUsableKnowledgeFields(fields: unknown): boolean {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  for (const [key, entry] of Object.entries(fields as Record<string, unknown>)) {
    if (key === "contentLanguage") continue;
    const values = knowledgeFactValue(entry);
    if (values.length > 0) return true;
    const value = entry && typeof entry === "object" ? (entry as { value?: unknown }).value : entry;
    if (value != null && typeof value !== "string" && typeof value !== "object") return true;
  }
  return false;
}

/** The first value of a stored or raw field, as text. */
export function knowledgeFieldText(fields: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = fields?.[key];
  const values = knowledgeFactValue(value);
  if (values.length > 0) return values[0];
  const raw = value && typeof value === "object" ? (value as { value?: unknown }).value : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** Every value of a stored or raw field. */
export function knowledgeFieldList(fields: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = fields?.[key];
  const values = knowledgeFactValue(value);
  if (values.length > 0) return values;
  const raw = value && typeof value === "object" ? (value as { value?: unknown }).value : value;
  return typeof raw === "string" ? raw.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean) : [];
}
