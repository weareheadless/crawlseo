import { describe, expect, it, vi } from "vitest";
import { embeddedCalls, imagesIn } from "@/lib/social/plan";
import { bySection, queryTokens, rankPages, runTool, type SocialTools } from "@/lib/social/tools";

const PAGES = [
  "https://www.susimacdonald.com/real-estate-listings/distrito-xcalacoco-beach---playa-del-carmen",
  "https://www.susimacdonald.com/playa-del-carmen-condos-sale",
  "https://www.susimacdonald.com/post/how-safe-is-the-riviera-maya-the-truth-behind-the-headlines",
  "https://www.susimacdonald.com/tulum-condos-sale",
];

describe("the site's own search", () => {
  it("keeps the words that identify a place", () => {
    expect(queryTokens("Xcalacoco Playa del Carmen")).toEqual(["xcalacoco", "playa", "carmen"]);
  });

  it("ranks the page that mentions most of the query first", () => {
    expect(rankPages("Xcalacoco", PAGES)).toEqual([PAGES[0]]);
    expect(rankPages("Tulum", PAGES)).toEqual([PAGES[3]]);
    expect(rankPages("Akumal", PAGES)).toEqual([]);
  });

  it("groups a long sitemap by its first path segment", () => {
    const sections = bySection(PAGES);
    expect(sections["/real-estate-listings/"]).toEqual([PAGES[0]]);
    expect(sections["/post/"]).toEqual([PAGES[2]]);
    expect(sections["(root)"]).toBeUndefined();
  });
});

describe("find_page", () => {
  const page = {
    url: PAGES[0],
    status: 200,
    title: "Distrito Xcalacoco Beach",
    description: "Beachfront condos",
    images: [{ url: "https://cdn.example/media/fachada.jpg/v1/fill/w_1600/fachada.jpg", width: 1600, alt: "Facade" }],
  };
  const tools: SocialTools = {
    readPage: vi.fn(async () => page),
    findPages: vi.fn(async () => [PAGES[0]]),
    brandPhotos: [],
  };

  it("opens the page it finds, so the photographs come with the search", async () => {
    const result = (await runTool("find_page", { query: "Xcalacoco" }, tools)) as {
      count: number;
      pages: Array<{ url: string; images: unknown[] }>;
    };
    expect(result.count).toBe(1);
    expect(result.pages[0].url).toBe(PAGES[0]);
    expect(result.pages[0].images).toHaveLength(1);
    expect(tools.readPage).toHaveBeenCalledWith(PAGES[0]);
  });

  it("counts the images inside those pages as permitted choices", async () => {
    const result = await runTool("find_page", { query: "Xcalacoco" }, tools);
    const permitted = new Set<string>();
    imagesIn(result, permitted);
    expect([...permitted]).toEqual([page.images[0].url]);
  });

  it("says so rather than inventing a page", async () => {
    const empty: SocialTools = { ...tools, findPages: vi.fn(async () => []), readPage: vi.fn() };
    const result = (await runTool("find_page", { query: "Akumal" }, empty)) as { count: number; pages: unknown[] };
    expect(result).toEqual({ query: "Akumal", count: 0, pages: [] });
    expect(empty.readPage).not.toHaveBeenCalled();
  });
});

describe("tool calls written as text", () => {
  it("reads the native-ish shape a model falls back to", () => {
    const calls = embeddedCalls(JSON.stringify({
      tool_calls: [{ name: "read_page", params: { url: PAGES[0] } }],
    }));
    expect(calls).toEqual([{ name: "read_page", args: { url: PAGES[0] } }]);
  });

  it("reads a single call with its arguments beside it", () => {
    const calls = embeddedCalls(JSON.stringify({ tool: "find_page", query: "Xcalacoco" }));
    expect(calls).toEqual([{ name: "find_page", args: { query: "Xcalacoco" } }]);
  });

  it("never mistakes a finished plan for a tool call", () => {
    expect(embeddedCalls(JSON.stringify({ post: true, copy: { headline: "x" } }))).toEqual([]);
    expect(embeddedCalls("not json")).toEqual([]);
  });
});
