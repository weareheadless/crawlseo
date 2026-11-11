import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  used: [] as string[],
  recorded: [] as Array<{ photoId: string; siteId: string | null; query: string }>,
}));

vi.mock("@/lib/db", () => ({
  db: {
    unsplashPhotoUse: {
      findMany: vi.fn(async () => state.used.map((photoId) => ({ photoId }))),
      create: vi.fn(async ({ data }: { data: { photoId: string; siteId: string | null; query: string } }) => {
        state.recorded.push(data);
        return { id: "use-1", ...data };
      }),
    },
  },
}));

import { findUnsplashCover, mentionsPlace, placeTokens } from "@/lib/delivery/unsplash";

function photo(id: string, alt: string, tags: string[] = []) {
  return {
    id,
    urls: { regular: `https://images.unsplash.com/${id}` },
    width: 1600,
    height: 900,
    alt_description: alt,
    tags: tags.map((title) => ({ title })),
    links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download` },
    user: { name: "A Photographer", links: { html: "https://unsplash.com/@a" } },
  };
}

let searchBodies: Record<string, unknown[]> = {};
let searches: string[] = [];

beforeEach(() => {
  vi.stubEnv("UNSPLASH_ACCESS_KEY", "test-key");
  state.used = [];
  state.recorded = [];
  searchBodies = {};
  searches = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/photos/1/download" || url.pathname.endsWith("/download")) {
      return new Response("{}", { status: 200 });
    }
    const query = url.searchParams.get("query") ?? "";
    searches.push(query);
    return new Response(JSON.stringify({ results: searchBodies[query] ?? [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("finding a cover", () => {
  it("never picks a photo another post already used", async () => {
    state.used = ["p1", "p2"];
    searchBodies = { "banks in playa del carmen": [photo("p1", "a"), photo("p2", "b"), photo("p3", "c")] };
    vi.spyOn(Math, "random").mockReturnValue(0);

    const cover = await findUnsplashCover("banks in playa del carmen");
    expect(cover.photoId).toBe("p3");
  });

  it("chooses at random instead of always taking the first result", async () => {
    searchBodies = { "banks in playa del carmen": [photo("p1", "a"), photo("p2", "b"), photo("p3", "c")] };
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const cover = await findUnsplashCover("banks in playa del carmen");
    expect(cover.photoId).toBe("p3");
  });

  it("uses the place before the topic and skips results that never mention the place", async () => {
    searches = [];
    searchBodies = {
      "banks Playa del Carmen": [photo("generic-1", "a calculator on a desk")],
      "Playa del Carmen": [
        photo("place-1", "Playa del Carmen beach at sunset"),
        photo("place-2", "Street in Playa del Carmen", ["Playa del Carmen"]),
      ],
    };
    vi.spyOn(Math, "random").mockReturnValue(0);

    const cover = await findUnsplashCover("banks", { location: "Playa del Carmen" });
    expect(cover.photoId).toBe("place-1");
    expect(cover.query).toBe("Playa del Carmen");
    // The topic-only query is never reached once the place has photos.
    expect(searches).not.toContain("banks");
  });

  it("records the photo it used", async () => {
    searchBodies = { "banks in playa del carmen": [photo("p1", "a")] };
    await findUnsplashCover("banks in playa del carmen", { siteId: "site-1" });
    expect(state.recorded).toEqual([{ photoId: "p1", siteId: "site-1", query: "banks in playa del carmen" }]);
  });

  it("still returns a used photo when every result has been used", async () => {
    state.used = ["p1"];
    searchBodies = { "banks in playa del carmen": [photo("p1", "a")] };
    const cover = await findUnsplashCover("banks in playa del carmen");
    expect(cover.photoId).toBe("p1");
  });
});

describe("place relevance", () => {
  it("reads the words that identify a place, ignoring short connectives", () => {
    expect(placeTokens("Playa del Carmen, Mexico")).toEqual(["playa", "carmen", "mexico"]);
    expect(placeTokens("Lisbon")).toEqual(["lisbon"]);
  });

  it("needs every identifying word in the photo's own metadata", () => {
    expect(mentionsPlace(photo("p", "Beach in Playa del Carmen"), ["playa", "carmen"])).toBe(true);
    expect(mentionsPlace(photo("p", "A beach in Mexico"), ["playa", "carmen"])).toBe(false);
  });
});
