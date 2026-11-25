import { describe, expect, it } from "vitest";
import { allowedImages, parsePlan, type PlannerInput } from "@/lib/social/plan";

const INPUT: PlannerInput = {
  brand: {
    name: "Susana MacDonald",
    voiceSample: "Playa del Carmen, not the postcard version.",
    tone: ["calm"],
    services: [],
    topics: [],
  },
  represented: ["Playa del Carmen", "Tulum"],
  posts: [{ subject: "Playa del Carmen", headline: "Old news.", publishedAt: null }],
  opportunities: [
    {
      title: "Expand the beachfront page",
      summary: "Thin page, 363 impressions.",
      type: "O2_striking_distance",
      status: "delivered",
      score: 70,
    },
  ],
  crawl: [{ url: "https://www.susimacdonald.com/beachfront", clicks: 2, impressions: 363, position: 14.2 }],
  research: [
    {
      theme: "Xcalacoco",
      summary: "A northern corridor is changing use.",
      confidence: 70,
      sourceUrl: "https://propertymex.com/resources",
    },
  ],
  photos: [
    { file: "susi-photo-1.jpg", description: "Rooftop pool, midday." },
    { file: "susi-photo-2.jpg", description: "Aerial of the beach." },
  ],
  locales: ["en"],
  today: "2026-11-24",
};

const VALID = {
  post: true,
  reason: "A corridor changing use is worth a buyer's attention.",
  subject: "Playa del Carmen",
  page_url: "https://www.susimacdonald.com/beachfront",
  angle: "Read the street, not the listing photo.",
  copy: {
    kicker: "Playa del Carmen",
    headline: "Xcalacoco is quietly becoming residential",
    subline: "A northern corridor is changing use.",
    caption: "Xcalacoco is shifting from tourism toward residential use.",
  },
  claims: [
    {
      text: "Xcalacoco is shifting from a tourist corridor toward residential use.",
      source_url: "https://propertymex.com/resources",
    },
  ],
  image: "susi-photo-1.jpg",
  art_direction: "Documentary, not postcard.",
};

describe("parsePlan", () => {
  it("accepts a well-formed plan and keeps its copy", () => {
    const result = parsePlan(VALID, INPUT);
    if ("error" in result) throw new Error(result.error);
    expect(result.plan.post).toBe(true);
    if (!result.plan.post) return;
    expect(result.plan.copy?.headline).toBe(VALID.copy.headline);
    expect(result.plan.claims).toHaveLength(1);
    expect(result.droppedClaims).toHaveLength(0);
  });

  it("treats a quiet day as an answer, but one that says why", () => {
    const quiet = parsePlan({ post: false, reason: "Nothing has changed since the last post." }, INPUT);
    if ("error" in quiet) throw new Error(quiet.error);
    expect(quiet.plan.post).toBe(false);

    const silent = parsePlan({ post: false }, INPUT);
    expect(silent).toHaveProperty("error");
  });

  it("drops a claim whose source never arrived, and says so", () => {
    const result = parsePlan(
      {
        ...VALID,
        claims: [
          ...VALID.claims,
          { text: "Prices doubled since 2024.", source_url: "https://a-blog-nobody-sent.example" },
        ],
      },
      INPUT,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.plan.post).toBe(true);
    if (!result.plan.post) return;
    expect(result.plan.claims.map((claim) => claim.text)).toEqual([VALID.claims[0].text]);
    expect(result.droppedClaims).toEqual(["Prices doubled since 2024."]);
  });

  it("refuses a claim with no source at all", () => {
    const result = parsePlan({ ...VALID, claims: [{ text: "Prices doubled." }] }, INPUT);
    if ("error" in result) throw new Error(result.error);
    if (!result.plan.post) return;
    expect(result.plan.claims).toHaveLength(0);
    expect(result.droppedClaims).toEqual(["Prices doubled."]);
  });

  it("refuses a post that promotes no page from the site", () => {
    const outsider = parsePlan({ ...VALID, page_url: "https://elsewhere.example/x" }, INPUT);
    expect(outsider).toHaveProperty("error");
    const missing = parsePlan({ ...VALID, page_url: "" }, INPUT);
    expect(missing).toHaveProperty("error");
  });

  it("refuses a subject the brand does not represent", () => {
    const result = parsePlan({ ...VALID, subject: "Mérida" }, INPUT);
    expect(result).toHaveProperty("error");
  });

  it("refuses a photo the brand does not have", () => {
    const result = parsePlan({ ...VALID, image: "stock-beach.jpg" }, INPUT);
    expect(result).toHaveProperty("error");
  });

  it("accepts an image URL a tool returned, and refuses one it did not", () => {
    const allowed = allowedImages(INPUT, ["https://cdn.example/media/villa.jpg/v1/fill/w_1600/villa.jpg"]);
    const ok = parsePlan(
      { ...VALID, image: "", image_url: "https://cdn.example/media/villa.jpg/v1/fill/w_1600/villa.jpg" },
      INPUT,
      allowed,
    );
    if ("error" in ok) throw new Error(ok.error);
    expect(ok.plan.post && ok.plan.imageUrl).toBe("https://cdn.example/media/villa.jpg/v1/fill/w_1600/villa.jpg");

    const refused = parsePlan({ ...VALID, image: "", image_url: "https://elsewhere.example/x.jpg" }, INPUT, allowed);
    expect(refused).toHaveProperty("error");
  });

  it("accepts a decision with no copy, because editorial writes the copy", () => {
    const result = parsePlan({ ...VALID, copy: undefined }, INPUT);
    if ("error" in result) throw new Error(result.error);
    if (!result.plan.post) throw new Error("expected a post");
    expect(result.plan.post).toBe(true);
    expect(result.plan.subject).toBe(VALID.subject);
    expect(result.plan.copy).toBeUndefined();
  });

  it("accepts a page from the crawl as a citable source", () => {
    const result = parsePlan(
      {
        ...VALID,
        claims: [{ text: "The beachfront page is thin.", source_url: "https://www.susimacdonald.com/beachfront" }],
      },
      INPUT,
    );
    if ("error" in result) throw new Error(result.error);
    if (!result.plan.post) return;
    expect(result.plan.claims).toHaveLength(1);
  });
});

describe("parsePlan after the last covers", () => {
  const RECENT: PlannerInput = {
    ...INPUT,
    posts: [
      {
        subject: "Playa del Carmen",
        headline: "Old news.",
        publishedAt: "2026-11-24T00:00:00Z",
        pageUrl: "https://www.susimacdonald.com/beachfront",
        image: "https://cdn.example/media/facade.jpg/v1/fill/w_1600/facade.jpg",
      },
    ],
  };

  it("refuses the page the last cover promoted", () => {
    const result = parsePlan(VALID, RECENT);
    expect(result).toHaveProperty("error");
  });

  it("refuses the photograph the last cover used", () => {
    const result = parsePlan(
      {
        ...VALID,
        image: "",
        image_url: "https://cdn.example/media/facade.jpg/v1/fill/w_1600/facade.jpg",
      },
      {
        ...RECENT,
        crawl: [
          ...INPUT.crawl,
          { url: "https://www.susimacdonald.com/tulum", clicks: 1, impressions: 90, position: 9 },
        ],
      },
      allowedImages(INPUT, ["https://cdn.example/media/facade.jpg/v1/fill/w_1600/facade.jpg"]),
    );
    expect(result).toHaveProperty("error");
  });

  it("accepts a new page and a different photograph", () => {
    const result = parsePlan(
      { ...VALID, page_url: "https://www.susimacdonald.com/tulum", image: "susi-photo-2.jpg" },
      {
        ...RECENT,
        crawl: [
          ...INPUT.crawl,
          { url: "https://www.susimacdonald.com/tulum", clicks: 1, impressions: 90, position: 9 },
        ],
      },
    );
    expect(result).not.toHaveProperty("error");
  });

  it("keeps a claim from a page a tool returned", () => {
    const page = "https://www.susimacdonald.com/tulum";
    const result = parsePlan(
      {
        ...VALID,
        page_url: page,
        claims: [{ text: "The town behind the ruins is where people buy.", source_url: page }],
      },
      INPUT,
      allowedImages(INPUT),
      new Set([...INPUT.crawl.map((row) => row.url), page]),
    );
    if ("error" in result) throw new Error(result.error);
    if (!result.plan.post) return;
    expect(result.plan.claims).toHaveLength(1);
  });
});
