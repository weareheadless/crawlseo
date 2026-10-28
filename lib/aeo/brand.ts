/** Brand identity used to judge whether an answer mentions the business. */
export type ResolvedBrand = { name: string | null; aliases: string[] };

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The canonical document is authoritative. Without one, the site domain is the
 * only recorded identity, so it is humanised rather than invented.
 */
export function resolveBrandIdentity(input: {
  businessName?: unknown;
  aliases?: unknown;
  domain?: string | null;
  projectName?: string | null;
}): ResolvedBrand {
  const documented = typeof input.businessName === "string" && input.businessName.trim() ? input.businessName.trim() : null;
  const aliases = Array.isArray(input.aliases)
    ? [...new Set(input.aliases.filter((alias): alias is string => typeof alias === "string" && Boolean(alias.trim())).map((alias) => alias.trim()))]
    : [];
  if (documented) return { name: documented, aliases: aliases.filter((alias) => alias.toLowerCase() !== documented.toLowerCase()) };
  const projectName = typeof input.projectName === "string" && input.projectName.trim() ? input.projectName.trim() : null;
  if (projectName) return { name: projectName, aliases: aliases.filter((alias) => alias.toLowerCase() !== projectName.toLowerCase()) };
  const domain = (input.domain ?? "").trim().toLowerCase();
  if (!domain) return { name: null, aliases };
  const host = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const label = host.split(".")[0];
  if (!label || label.length < 2) return { name: null, aliases };
  const name = titleCase(label);
  return { name, aliases: aliases.filter((alias) => alias.toLowerCase() !== name.toLowerCase()) };
}

/** A research summary is not a buyer question; only question-shaped text may be asked verbatim. */
export function looksLikeQuestion(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (text.endsWith("?")) return true;
  return /^(who|what|where|when|why|how|is|are|can|does|do|should|which|qu(e|i)|comment|pourquoi|o[uù]|quel(le)?s?)\b/i.test(text);
}

export function questionFromTheme(theme: string): string | null {
  const clean = theme.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
  if (!clean) return null;
  return `What should a buyer know about ${clean}?`;
}
