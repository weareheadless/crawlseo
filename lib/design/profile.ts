import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";

export type SiteDesignProfile = {
  source: "repo" | "live" | "human";
  repoPath: string | null;
  palette: string[];
  fonts: string[];
  notes: string;
  scannedFiles: number;
  skippedFiles: number;
  updatedAt: string;
};

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", ".releases",
  ".agent-worktrees", ".tmp", "out", "vendor",
]);
const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".sass", ".html", ".json",
  ".mdx", ".vue", ".svelte",
]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 300_000;
const MAX_TOTAL_BYTES = 4_000_000;

const COLOR = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const FONT = /font-family\s*:\s*([^;}{]+)/gi;
const FONT_VAR = /--font[a-zA-Z0-9-]*\s*:\s*([^;}{]+)/gi;

function normalizeColor(value: string): string {
  const lower = value.toLowerCase();
  if (lower.length === 4) return `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`;
  return lower;
}

function rank(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function firstFontFamily(value: string): string | null {
  const first = value.split(",")[0]?.trim().replace(/^["']|["']$/g, "").trim();
  if (!first || /^(inherit|initial|unset|revert)$/i.test(first)) return null;
  // A font-family declaration inside a JavaScript regex or template can match
  // characters that no font name contains. Reject those instead of storing a
  // pattern fragment as a typeface.
  if (/[()[\]{}<>/\\|?*+=^$]/.test(first)) return null;
  if (first.length > 60) return null;
  return first;
}

type Collected = {
  colors: Map<string, number>;
  fonts: Map<string, number>;
  scanned: number;
  skipped: number;
};

function collect(text: string, into: Collected) {
  for (const match of text.matchAll(COLOR)) {
    const color = normalizeColor(match[0]);
    into.colors.set(color, (into.colors.get(color) ?? 0) + 1);
  }
  for (const regex of [FONT, FONT_VAR]) {
    for (const match of text.matchAll(regex)) {
      const family = firstFontFamily(match[1] ?? "");
      if (family) into.fonts.set(family, (into.fonts.get(family) ?? 0) + 1);
    }
  }
}

function toProfile(
  collected: Collected,
  source: SiteDesignProfile["source"],
  repoPath: string | null,
  notes = "",
): SiteDesignProfile {
  return {
    source,
    repoPath,
    palette: rank(collected.colors, 16),
    fonts: rank(collected.fonts, 6),
    notes,
    scannedFiles: collected.scanned,
    skippedFiles: collected.skipped,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Read a site repository for the palette and fonts it already uses.
 *
 * This is a fact extraction: it counts literal colours and font-family
 * declarations. It does not decide which one is the brand colour; the model
 * reads the repository and the stored profile decides how to use them.
 */
export async function extractDesignProfileFromRepo(repoPath: string): Promise<SiteDesignProfile> {
  const collected: Collected = { colors: new Map(), fonts: new Map(), scanned: 0, skipped: 0 };
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    if (collected.scanned >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
      collected.skipped += 1;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.scanned >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
        collected.skipped += 1;
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) {
          collected.skipped += 1;
          continue;
        }
        const text = await readFile(full, "utf8");
        totalBytes += info.size;
        collected.scanned += 1;
        collect(text, collected);
      } catch {
        collected.skipped += 1;
      }
    }
  };

  await walk(repoPath);
  return toProfile(collected, "repo", repoPath);
}

/** Extract the same facts from a rendered page when no repository is configured. */
export function extractDesignProfileFromHtml(html: string, liveUrl: string | null): SiteDesignProfile {
  const collected: Collected = { colors: new Map(), fonts: new Map(), scanned: 1, skipped: 0 };
  collect(html, collected);
  return toProfile(collected, "live", liveUrl);
}

export async function getStoredDesignProfile(siteId: string): Promise<SiteDesignProfile | null> {
  const profile = await db.siteProfile.findUnique({ where: { siteId }, select: { design: true } });
  const value = profile?.design;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const palette = Array.isArray(row.palette) ? row.palette.filter((item): item is string => typeof item === "string") : [];
  const fonts = Array.isArray(row.fonts) ? row.fonts.filter((item): item is string => typeof item === "string") : [];
  if (palette.length === 0 && fonts.length === 0 && !row.notes) return null;
  return {
    source: row.source === "live" || row.source === "human" ? row.source : "repo",
    repoPath: typeof row.repoPath === "string" ? row.repoPath : null,
    palette,
    fonts,
    notes: typeof row.notes === "string" ? row.notes : "",
    scannedFiles: typeof row.scannedFiles === "number" ? row.scannedFiles : 0,
    skippedFiles: typeof row.skippedFiles === "number" ? row.skippedFiles : 0,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
  };
}

export async function saveDesignProfile(siteId: string, profile: SiteDesignProfile): Promise<SiteDesignProfile> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } });
  if (!site) throw new Error("Site not found");
  await db.siteProfile.upsert({
    where: { siteId },
    create: {
      siteId,
      projectId: site.projectId,
      language: "en",
      design: profile as never,
    },
    update: { design: profile as never },
  });
  return profile;
}

/**
 * The profile a page task should use. A stored profile wins. Otherwise the
 * configured repository is read once and the result is stored, so later runs
 * do not rescan the repository and a human can edit the notes.
 */
export async function designProfileForSite(
  siteId: string,
  repoPath: string | null,
): Promise<SiteDesignProfile | null> {
  const stored = await getStoredDesignProfile(siteId);
  if (stored) return stored;
  if (!repoPath) return null;
  try {
    const extracted = await extractDesignProfileFromRepo(repoPath);
    if (extracted.palette.length === 0 && extracted.fonts.length === 0) return extracted;
    return await saveDesignProfile(siteId, extracted);
  } catch {
    return null;
  }
}
