export type UnsplashCover = {
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
  urls?: { regular?: string; full?: string };
  width?: number;
  height?: number;
  alt_description?: string;
  description?: string;
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

export async function findUnsplashCover(query: string): Promise<UnsplashCover> {
  const key = accessKey();
  if (!key) throw new Error("UNSPLASH_ACCESS_KEY is not configured");
  const exact = query.trim().slice(0, 180) || "Riviera Maya Mexico";
  const lower = exact.toLowerCase();
  const location = ["Cancun", "Tulum", "Playa del Carmen", "Riviera Maya", "Normandie", "Normandy", "France", "Mexico"]
    .find((place) => lower.includes(place.toLowerCase()));
  const short = exact.replace(/[^a-z0-9\s]/gi, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  const candidates = [...new Set([
    exact,
    short,
    location === "Cancun" ? "Cancun Mexico" : location ? `${location} landscape` : "",
    "Mexico Caribbean coast",
    "coastal landscape",
  ].filter(Boolean))];

  let photo: UnsplashPhoto | undefined;
  let search = exact;
  for (const candidate of candidates) {
    const url = new URL("https://api.unsplash.com/search/photos");
    url.searchParams.set("query", candidate);
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("per_page", "12");
    url.searchParams.set("content_filter", "high");
    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) continue;
    const body = await response.json() as { results?: UnsplashPhoto[] };
    const photos = (body.results ?? []).filter((row) =>
      !row.sponsorship
      && row.urls?.regular
      && row.links?.download_location
      && row.user?.name,
    );
    if (photos[0]) {
      photo = photos[0];
      search = candidate;
      break;
    }
  }
  if (!photo?.urls?.regular || !photo.links?.download_location) {
    throw new Error(`Unsplash returned no usable landscape image for “${exact}”`);
  }

  const download = new URL(photo.links.download_location);
  download.searchParams.set("client_id", key);
  await fetch(download, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);

  return {
    url: photo.urls.regular,
    width: photo.width ?? 1600,
    height: photo.height ?? 900,
    altText: (photo.alt_description || photo.description || search).slice(0, 300),
    photographer: photo.user?.name ?? "Unsplash contributor",
    photographerUrl: withUtm(photo.user?.links?.html ?? photo.links.download_location),
    photoUrl: withUtm(photo.links.html ?? photo.links.download_location),
    downloadLocation: photo.links.download_location,
    query: search,
  };
}

export async function importUnsplashCover(
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>,
  cover: UnsplashCover,
  slug: string,
): Promise<{ mediaId: string; url: string; altText: string; cover: UnsplashCover }> {
  const parsed = new URL(cover.url);
  if (parsed.hostname !== "images.unsplash.com") {
    throw new Error("Unsplash returned an unexpected image host");
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
      displayName: `${slug}-cover.jpg`,
      private: false,
      labels: ["Unsplash", "CrawlSEO"],
    },
  );
  const file = response.file;
  if (!file?.id) throw new Error("Wix image import returned no media ID");
  return {
    mediaId: file.id,
    url: file.url ?? parsed.toString(),
    altText: cover.altText,
    cover,
  };
}
