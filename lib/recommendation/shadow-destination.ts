import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Shadow analysis writes one JSON artifact and reads one database. Both
 * destinations must be explicit and isolated before any model call or write.
 *
 * A query-string schema check alone is not proof of the connection destination,
 * so the CLI opens the validated URL itself rather than the application client.
 */

export type ShadowDestination = {
  outPath: string;
  databaseUrl: string | null;
};

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertShadowOutputPath(
  outPath: string,
  opts: { allowedRoot?: string; repoRoot?: string; overwrite?: boolean } = {}
): string {
  if (!outPath || outPath.trim().length === 0) throw new Error("shadow output path is required");
  if (!isAbsolute(outPath)) throw new Error("shadow output path must be absolute");
  const resolved = resolve(outPath);
  if (!resolved.endsWith(".json")) throw new Error("shadow output path must end in .json");

  const repoRoot = opts.repoRoot ?? process.cwd();
  if (inside(repoRoot, resolved)) {
    throw new Error("shadow output path must be outside the repository");
  }
  const allowedRoot = opts.allowedRoot ?? process.env.SHADOW_OUTPUT_ROOT ?? "/tmp/opencode";
  if (!inside(allowedRoot, resolved)) {
    throw new Error(`shadow output path must be inside ${allowedRoot}`);
  }
  if (existsSync(resolved)) {
    if (statSync(resolved).isDirectory()) throw new Error("shadow output path is a directory");
    if (!opts.overwrite) {
      throw new Error("shadow output path already exists; pass --overwrite to replace a previous report");
    }
  }
  return resolved;
}

export function assertShadowDatabaseUrl(
  databaseUrl: string,
  opts: { applicationUrl?: string | null } = {}
): string {
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error("shadow analysis requires an explicit disposable database URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("shadow database URL is not a valid URL");
  }
  const schema = parsed.searchParams.get("schema");
  if (!schema) throw new Error("shadow database URL must name an explicit schema");
  if (schema.toLowerCase() === "public") {
    throw new Error("shadow database URL must not use the public schema");
  }
  if (!/^[a-z0-9_]+$/i.test(schema)) throw new Error("shadow database schema name is not safe");
  const applicationUrl = opts.applicationUrl ?? process.env.DATABASE_URL ?? null;
  if (applicationUrl && databaseUrl === applicationUrl) {
    throw new Error("shadow database URL is the application database URL");
  }
  return databaseUrl;
}

export function assertShadowDestination(input: {
  outPath: string;
  databaseUrl?: string | null;
  overwrite?: boolean;
}): ShadowDestination {
  return {
    outPath: assertShadowOutputPath(input.outPath, { overwrite: input.overwrite }),
    databaseUrl: input.databaseUrl ? assertShadowDatabaseUrl(input.databaseUrl) : null,
  };
}
