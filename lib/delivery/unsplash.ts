import { db } from "@/lib/db";

export type UnsplashCover = {
  photoId: string;
  url: string;
  width: number;
  height: number;
  altText: string;
  photographer: string;
  photographerUrl: string;
  photoUrl: string;
  downloadLocation: string;
  query: string;
};

type UnsplashPhoto = {
  id?: string;
  urls?: { regular?: string; full?: string };
  width?: number;
  height?: number;
  alt_description?: string;
  description?: string;
  tags?: Array<{ title?: string }>;
  sponsorship?: unknown;
  links?: { html?: string; download_location?: string };
  user?: { name?: string; links?: { html?: string } };
};

function accessKey(): string {
  return (process.env.UNSPLASH_ACCESS_KEY || "").trim();
}

function withUtm(value: string): string {
  try {
    const url = new URL(value);
    url.searchParams.set("utm_source", "crawlseo");
    url.searchParams.set("utm_medium", "referral");
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Search terms to try.
 *
 * The place the business is in is the strongest signal a reader recognises, so
 * when there is one it comes before the article's own wording: a bank guide in
 * Playa del Carmen gets a photo of the place, not a stock calculator. With no
 * place the query leads. No place names are hardcoded: the caller supplies the
 * business's own location.
 */
export function coverCandidates(query: string, location?: string | null): string[] {
  const exact = query.trim().slice(0, 180);
  const short = exact.replace(/[^a-z0-9\s]/gi, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  const place = primaryPlace(location);
  if (!exact) return place ? [...new Set([place, `${place} landscape`, "landscape"])] : ["landscape"];
  if (!place) return [...new Set([exact, short, "landscape"].filter(Boolean))];
  // "Playa del Carmen Playa del Carmen" is not a query.
  const topic = short || exact;
  const combined = topic.toLowerCase().includes(place.toLowerCase()) ? "" : `${topic} ${place}`;
  return [...new Set([
    combined,
    place,
    exact,
    short,
    `${place} landscape`,
    "landscape",
  ].filter(Boolean))];
}

/**
 * The one place a photo can actually be of.
 *
 * A site's location is often a whole market ("Playa Del Carmen, Tulum & Riviera
 * Maya"). No photograph shows all of it, so the image search uses the first,
 * specific place and leaves the wider description to the copy.
 */
export function primaryPlace(location?: string | null): string {
  return (location ?? "").split(/[,&|/]+/)[0]?.trim().slice(0, 80) ?? "";
}

/** Words in a place name long enough to identify it, ignoring `del`, `de`, `la`. */
export function placeTokens(place: string): string[] {
  return place
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 4);
}

/**
 * Whether a photo's own metadata places it where the business is.
 *
 * This is a fact about the result Unsplash returned (its alt text, description
 * or tags), not a guess about what the image shows, so a place search whose
 * results happen not to mention the place is skipped rather than shipped.
 */
export function mentionsPlace(photo: UnsplashPhoto, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    photo.alt_description,
    photo.description,
    ...(photo.tags ?? []).map((tag) => tag.title ?? ""),
  ].filter(Boolean).join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

async function usedPhotoIds(): Promise<Set<string>> {
  const rows = await db.unsplashPhotoUse.findMany({ select: { photoId: true } }).catch(() => []);
  return new Set(rows.map((row) => row.photoId));
}

async function recordPhotoUse(photoId: string, siteId: string | null, query: string): Promise<void> {
  await db.unsplashPhotoUse
    .create({ data: { photoId, siteId, query } })
    .catch(() => undefined);
}

/**
 * Pick a cover for one draft.
 *
 * Every candidate query is searched, its usable photos are filtered to the ones
 * that are actually about the place when the query names it, and the choice is
 * random among the photos no other post has used. The most relevant result is
 * therefore not automatically the one every article gets.
 */
export async function findUnsplashCover(
  query: string,
  options: { location?: string | null; siteId?: string | null } = {},
): Promise<UnsplashCover> {
  const key = accessKey();
  if (!key) throw new Error("UNSPLASH_ACCESS_KEY is not configured");
  const exact = query.trim().slice(0, 180);
  const place = primaryPlace(options.location);
  const tokens = placeTokens(place);
  const candidates = coverCandidates(query, options.location);
  const used = await usedPhotoIds();

  const searchPhotos = async (candidate: string): Promise<UnsplashPhoto[]> => {
    const url = new URL("https://api.unsplash.com/search/photos");
    url.searchParams.set("query", candidate);
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("per_page", "20");
    url.searchParams.set("content_filter", "high");
    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return [];
    const body = await response.json() as { results?: UnsplashPhoto[] };
    return (body.results ?? []).filter((row) =>
      !row.sponsorship
      && row.id
      && row.urls?.regular
      && row.links?.download_location
      && row.user?.name,
    );
  };

  let chosen: { photo: UnsplashPhoto; query: string } | null = null;
  let reuse: { photo: UnsplashPhoto; query: string } | null = null;
  for (const candidate of candidates) {
    const found = await searchPhotos(candidate);
    if (found.length === 0) continue;
    const namesPlace = place.length > 0 && candidate.toLowerCase().includes(place.toLowerCase());
    const inPlace = namesPlace ? found.filter((photo) => mentionsPlace(photo, tokens)) : found;
    // A place query that returns nothing about the place is not a place photo.
    if (namesPlace && inPlace.length === 0) continue;
    const pool = inPlace.length > 0 ? inPlace : found;
    const unused = pool.filter((photo) => !used.has(String(photo.id)));
    if (unused.length > 0) {
      chosen = { photo: pickRandom(unused), query: candidate };
      break;
    }
    // Every photo this query returned has been used; keep it only as a last
    // resort so a missing cover never blocks publishing.
    reuse ??= { photo: pickRandom(pool), query: candidate };
  }

  const picked = chosen ?? reuse;
  const photo = picked?.photo;
  const regular = photo?.urls?.regular;
  const downloadLocation = photo?.links?.download_location;
  if (!photo || !regular || !downloadLocation) {
    throw new Error(`Unsplash returned no usable landscape image for “${exact}”`);
  }
  const id = String(photo.id);
  const queryUsed = picked?.query ?? exact;

  const download = new URL(downloadLocation);
  download.searchParams.set("client_id", key);
  await fetch(download, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  await recordPhotoUse(id, options.siteId ?? null, queryUsed);

  return {
    photoId: id,
    url: regular,
    width: photo.width ?? 1600,
    height: photo.height ?? 900,
    altText: (photo.alt_description || photo.description || queryUsed).slice(0, 300),
    photographer: photo.user?.name ?? "Unsplash contributor",
    photographerUrl: withUtm(photo.user?.links?.html ?? downloadLocation),
    photoUrl: withUtm(photo.links?.html ?? downloadLocation),
    downloadLocation,
    query: queryUsed,
  };
}

export type ImportedImage = { mediaId: string; url: string; altText: string };

/**
 * Import one remote image into the Wix media library.
 *
 * The writer already chose and attributed the picture; this only moves the
 * bytes into Wix so Ricos can reference a media id. It is the same path for a
 * cover and for an inline image.
 */
export async function importImageAsset(
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>,
  image: { url: string; altText: string; width?: number; height?: number },
  displayName: string,
): Promise<ImportedImage> {
  const parsed = new URL(image.url);
  if (parsed.hostname !== "images.unsplash.com") {
    throw new Error("The image is not hosted on Unsplash's image host");
  }
  parsed.searchParams.set("w", "1600");
  parsed.searchParams.set("q", "85");
  parsed.searchParams.set("fit", "max");
  parsed.searchParams.set("fm", "jpg");

  const response = await request<{ file?: { id?: string; url?: string } }>(
    "POST",
    "/site-media/v1/files/import",
    {
      url: parsed.toString(),
      mediaType: "IMAGE",
      mimeType: "image/jpeg",
      displayName: displayName.slice(0, 120),
      private: false,
      labels: ["Unsplash", "CrawlSEO"],
    },
  );
  const file = response.file;
  if (!file?.id) throw new Error("Wix image import returned no media ID");
  return {
    mediaId: file.id,
    url: file.url ?? parsed.toString(),
    altText: image.altText,
  };
}

export async function importUnsplashCover(
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>,
  cover: UnsplashCover,
  slug: string,
): Promise<{ mediaId: string; url: string; altText: string; cover: UnsplashCover }> {
  const imported = await importImageAsset(
    request,
    { url: cover.url, altText: cover.altText, width: cover.width, height: cover.height },
    `${slug}-cover.jpg`,
  );
  return { ...imported, cover };
}
