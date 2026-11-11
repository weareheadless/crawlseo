/**
 * Reading a Wix page's rendered content for the review preview.
 *
 * A Velo page keeps its copy in object literals and hands them to a custom
 * element with `setAttribute("config", JSON.stringify(...))`. The review
 * preview used to mount the element alone, so it rendered the component's
 * built-in hero and none of the content the page supplies — the very content
 * a reviewer needs to see.
 *
 * These helpers read what the page already says, without executing Velo code:
 * the config literals are JSON, and the element's attributes are declared in
 * its own source.
 */

export type ConfigVariant = {
  /** The constant the page assigns, e.g. `CONFIG_ES`. */
  name: string;
  config: unknown;
};

const ASSIGNMENT = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
const CONFIG_ATTRIBUTE = /setAttribute\(\s*['"]config['"]\s*,\s*JSON\.stringify\(\s*([^)]+)\)/g;

/** The end of a `{...}` literal, skipping strings and escapes. */
function objectEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Object literals in a page file that are valid JSON. */
export function extractJsonObjectLiterals(source: string): Array<{ name: string; config: unknown }> {
  const found: Array<{ name: string; config: unknown }> = [];
  for (const match of source.matchAll(ASSIGNMENT)) {
    const start = source.indexOf("{", match.index);
    if (start < 0) continue;
    const end = objectEnd(source, start);
    if (end < 0) continue;
    let config: unknown;
    try {
      config = JSON.parse(source.slice(start, end + 1));
    } catch {
      // Not a JSON literal; it is code, and guessing at it is worse than skipping.
      continue;
    }
    if (config && typeof config === "object" && !Array.isArray(config)) {
      found.push({ name: match[1], config });
    }
  }
  return found;
}

/**
 * The config objects a page can hand to its element.
 *
 * The page may choose between variants at runtime (`ACTIVE = isSpanish ?
 * CONFIG_ES : CONFIG`), so every config literal reachable from the
 * `setAttribute("config", ...)` call is returned: the reviewer sees each market
 * or locale the page can render.
 */
export function extractConfigVariants(source: string): ConfigVariant[] {
  const literals = extractJsonObjectLiterals(source);
  const byName = new Map(literals.map((literal) => [literal.name, literal]));

  const referenced = new Set<string>();
  const inlineVariants: ConfigVariant[] = [];
  for (const match of source.matchAll(CONFIG_ATTRIBUTE)) {
    const expression = match[1] ?? "";
    // An inline `JSON.stringify({...})` is a config too.
    const inline = expression.trim().startsWith("{") ? expression.trim() : null;
    if (inline) {
      try {
        const config = JSON.parse(inline);
        if (config && typeof config === "object") inlineVariants.push({ name: "config", config });
        continue;
      } catch {
        // Fall through to the named variants.
      }
    }
    for (const identifier of expression.matchAll(/[A-Za-z_$][\w$]*/g)) referenced.add(identifier[0]);
  }
  if (inlineVariants.length > 0) return inlineVariants;
  if (referenced.size === 0) return [];

  // One level of indirection: `const ACTIVE = cond ? CONFIG_ES : CONFIG;`.
  for (const name of [...referenced]) {
    const definition = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*([^;]+);`).exec(source);
    if (!definition) continue;
    for (const identifier of definition[1].matchAll(/[A-Za-z_$][\w$]*/g)) referenced.add(identifier[0]);
  }

  const variants: ConfigVariant[] = [];
  const seen = new Set<string>();
  // File order, so the page's own default config leads.
  for (const literal of literals) {
    if (!referenced.has(literal.name) || seen.has(literal.name)) continue;
    seen.add(literal.name);
    variants.push({ name: literal.name, config: literal.config });
  }
  return variants;
}

/**
 * Whether a component declares an attribute in `observedAttributes`.
 *
 * A fact from the component's own source: a page cannot drive a mode the
 * element does not watch, so the preview only sets attributes the element
 * actually reads.
 */
export function componentAccepts(source: string, attribute: string): boolean {
  const match = /observedAttributes\s*\(\s*\)\s*\{\s*return\s*\[([^\]]*)\]/.exec(source);
  if (!match) return false;
  return new RegExp(`['"]${escapeRegExp(attribute)}['"]`).test(match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
