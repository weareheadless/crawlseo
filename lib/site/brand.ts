import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/**
 * The brand, in one record.
 *
 * It used to live twice: here, and in Cicero's `brands/<id>/brand.json`. The two
 * drifted — the file's `logo_path` was empty while the logo existed — and four
 * posts shipped without it. A renderer now reads this record and keeps at most a
 * cache of it, keyed by `revision`.
 *
 * Precedence: `SiteProfile.brand` wins. `SiteProfile.design` is a scan of the
 * site's stylesheets, kept to *prefill* the block for a human; nothing renders
 * from it, and a profile with only `design` is reported as not configured rather
 * than rendered with a guessed palette.
 *
 * Representation answers the other half of the question — not "what does the
 * brand look like" but "what may this brand promote". The social eligibility gate
 * reads it from here; no channel keeps its own copy.
 */

export type BrandLogo = {
  /** The asset store's identifier, when the logo is managed rather than a path. */
  assetId: string;
  /** A path a file-based renderer can read (repository- or store-relative). */
  path: string;
  /** A URL a remote renderer can fetch. */
  url: string | null;
  alt: string;
  /**
   * Whether the logo already contains the brand name. Null means unknown, and a
   * renderer must then not repeat the name beside it: a duplicated wordmark is
   * worse than a missing one.
   */
  hasText: boolean | null;
  width: number | null;
  height: number | null;
};

/**
 * Who the brand is for, and what it is trusted with.
 *
 * The identity block says what the brand looks like. This says what it is
 * *about*: the reader it serves, the thing that reader is protecting, and the
 * traps the brand must not fall into. A designer that has this can make a cover
 * that argues something; without it, every cover is a photograph with the
 * headline underneath.
 */
export type BrandPersona = {
  /** What the brand is for, in one sentence. */
  positioning: string;
  /** Who it serves, and what that person is protecting. */
  audience: string;
  /** What it is trusted with. */
  promise: string;
  /** What this brand is not. Copy and design both have to avoid these. */
  avoids: string[];
};

export const EMPTY_PERSONA: BrandPersona = {
  positioning: "",
  audience: "",
  promise: "",
  avoids: [],
};

export type SiteBrand = {
  schemaVersion: "brand/1";
  name: string;
  logo: BrandLogo | null;
  /** Named colours, `#rrggbb`, lower-case. Names are the brand's own ("ink", "sand"). */
  colors: Record<string, string>;
  fonts: { display: string; body: string; mono: string };
  voice: { sample: string; tone: string[] };
  /** Optional: a brand without one renders, it just has less to say. */
  persona: BrandPersona;
  notes: string;
};

export type RepresentationEntry = {
  kind: "project" | "developer" | "service" | "place";
  name: string;
  aliases: string[];
  url: string | null;
  note: string;
};

export type SiteRepresentation = {
  schemaVersion: "representation/1";
  /** Where the brand sells. Countries are ISO-3166 alpha-2, upper-case. */
  serviceArea: { countries: string[]; regions: string[]; places: string[] };
  entries: RepresentationEntry[];
};

export type SiteBrandRecord = {
  siteId: string;
  brand: SiteBrand | null;
  representation: SiteRepresentation;
  /** SHA-256 of the record. A consumer caches by this and nothing else. */
  revision: string;
  /** False when the profile has no brand block, so a renderer must refuse. */
  configured: boolean;
  updatedAt: string | null;
};

export type BrandReadDb = Pick<PrismaClient, "siteProfile">;
export type BrandWriteDb = Pick<PrismaClient, "site" | "siteProfile">;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const COLOR_NAME = /^[a-z][a-z0-9-]{0,30}$/i;
const FONT_BAD = /[()[\]{}<>/\\|?*+=^$]/;
const COUNTRY = /^[A-Za-z]{2}$/;
const ENTRY_KINDS = new Set(["project", "developer", "service", "place"]);

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function strings(value: unknown, limit = 80): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => text(entry, 120))
    .filter((entry) => entry.length > 0 && entry.length <= limit);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeColor(value: string): string | null {
  if (!HEX.test(value)) return null;
  const lower = value.toLowerCase();
  return lower.length === 4
    ? `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`
    : lower;
}

function normalizeFont(value: unknown): string {
  const family = text(value, 60);
  if (!family || FONT_BAD.test(family)) return "";
  return family.replace(/^["']|["']$/g, "").trim();
}

function normalizeUrl(value: unknown): string | null {
  const raw = text(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeSize(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 20000
    ? Math.round(value)
    : null;
}

function normalizeLogo(value: unknown): BrandLogo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const path = text(row.path, 512);
  const url = normalizeUrl(row.url);
  // A reference that names neither a path nor a URL is not a reference. Dropping
  // it here is what makes "the logo is missing" observable downstream instead of
  // silently rendering a post without one.
  if (!path && !url) return null;
  return {
    assetId: text(row.assetId, 120),
    path,
    url,
    alt: text(row.alt, 300),
    hasText: typeof row.hasText === "boolean" ? row.hasText : null,
    width: normalizeSize(row.width),
    height: normalizeSize(row.height),
  };
}

function normalizeColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const colors: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim().toLowerCase();
    if (!COLOR_NAME.test(name)) continue;
    const color = typeof rawValue === "string" ? normalizeColor(rawValue) : null;
    if (color) colors[name] = color;
  }
  return colors;
}

function normalizePersona(value: unknown): BrandPersona {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_PERSONA };
  const row = value as Record<string, unknown>;
  return {
    positioning: text(row.positioning, 600),
    audience: text(row.audience, 600),
    promise: text(row.promise, 600),
    avoids: unique(strings(row.avoids)).slice(0, 12),
  };
}

export function parseSiteBrand(value: unknown): SiteBrand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const name = text(row.name, 120);
  // A brand block without a name is not a brand; refusing it here keeps a
  // half-filled record from becoming a post signed by nobody.
  if (!name) return null;
  const fonts = (row.fonts ?? {}) as Record<string, unknown>;
  const voice = (row.voice ?? {}) as Record<string, unknown>;
  return {
    schemaVersion: "brand/1",
    name,
    logo: normalizeLogo(row.logo),
    colors: normalizeColors(row.colors),
    fonts: {
      display: normalizeFont(fonts.display),
      body: normalizeFont(fonts.body),
      mono: normalizeFont(fonts.mono),
    },
    voice: { sample: text(voice.sample, 4000), tone: strings(voice.tone) },
    persona: normalizePersona(row.persona),
    notes: text(row.notes, 2000),
  };
}

function normalizeEntry(value: unknown): RepresentationEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kind = text(row.kind, 20).toLowerCase();
  const name = text(row.name, 200);
  if (!ENTRY_KINDS.has(kind) || !name) return null;
  const aliases = unique(strings(row.aliases)).filter((alias) => alias.toLowerCase() !== name.toLowerCase());
  return { kind: kind as RepresentationEntry["kind"], name, aliases, url: normalizeUrl(row.url), note: text(row.note, 500) };
}

function countries(value: unknown): string[] {
  return unique(
    strings(value)
      .filter((entry) => COUNTRY.test(entry))
      .map((entry) => entry.toUpperCase())
  );
}

export function emptyRepresentation(): SiteRepresentation {
  return { schemaVersion: "representation/1", serviceArea: { countries: [], regions: [], places: [] }, entries: [] };
}

export function parseSiteRepresentation(value: unknown): SiteRepresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyRepresentation();
  const row = value as Record<string, unknown>;
  const area = (row.serviceArea ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(row.entries)
    ? row.entries.map(normalizeEntry).filter((entry): entry is RepresentationEntry => Boolean(entry))
    : [];
  return {
    schemaVersion: "representation/1",
    serviceArea: {
      countries: countries(area.countries),
      regions: unique(strings(area.regions)),
      places: unique(strings(area.places)),
    },
    // Two entries with one name are one subject; the gate would otherwise report
    // the same name represented twice.
    entries: unique(entries.map((entry) => entry.name)).map((name) => entries.find((entry) => entry.name === name)!),
  };
}

/** Canonical JSON: same record, same hash, whatever order the keys arrived in. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

export function siteBrandRevision(brand: SiteBrand | null, representation: SiteRepresentation): string {
  const digest = createHash("sha256").update(stableStringify({ brand, representation }), "utf8").digest("hex");
  return `sha256:${digest}`;
}

/**
 * Every name the brand may promote, lower-cased and de-duplicated: project and
 * developer names, the services it offers, the places it sells in, and their
 * aliases. This is the list the eligibility gate matches a subject against.
 */
export function representedNames(representation: SiteRepresentation): string[] {
  const names = representation.entries.flatMap((entry) => [entry.name, ...entry.aliases]);
  return unique([...names, ...representation.serviceArea.places].map((name) => name.toLowerCase())).sort();
}

export async function readSiteBrand(db: BrandReadDb, siteId: string): Promise<SiteBrandRecord | null> {
  const profile = await db.siteProfile.findUnique({
    where: { siteId },
    select: { brand: true, representation: true, updatedAt: true },
  });
  if (!profile) return null;
  const brand = parseSiteBrand(profile.brand);
  const representation = parseSiteRepresentation(profile.representation);
  return {
    siteId,
    brand,
    representation,
    revision: siteBrandRevision(brand, representation),
    configured: brand !== null,
    updatedAt: profile.updatedAt ? profile.updatedAt.toISOString() : null,
  };
}

export async function saveSiteBrand(
  db: BrandWriteDb,
  siteId: string,
  input: { brand: unknown; representation?: unknown }
): Promise<SiteBrandRecord> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } });
  if (!site) throw new Error("Site not found");
  const brand = parseSiteBrand(input.brand);
  const representation = parseSiteRepresentation(input.representation);
  await db.siteProfile.upsert({
    where: { siteId },
    create: { siteId, projectId: site.projectId, brand: brand as never, representation: representation as never },
    update: { brand: brand as never, representation: representation as never },
  });
  const record = await readSiteBrand(db as BrandReadDb, siteId);
  if (!record) throw new Error("Site profile was not written");
  return record;
}
