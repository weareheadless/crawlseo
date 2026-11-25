import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyRepresentation, parseSiteRepresentation } from "@/lib/site/brand";

/**
 * The brand profile is written from one screen and read by every render, so the
 * route is tested against the real record functions: the persona has to survive
 * the round trip, and saving a brand must not erase what the eligibility gate
 * knows about what the brand may promote.
 */

const mocks = vi.hoisted(() => ({
  getUserId: vi.fn(async (): Promise<string | null> => "operator-1"),
  ownsSite: vi.fn(async () => true),
}));

const store = vi.hoisted(() => ({
  brand: null as unknown,
  representation: null as unknown,
  updatedAt: null as Date | null,
}));

vi.mock("@/lib/db", () => ({
  db: {
    site: { findUnique: async () => ({ projectId: "project-1" }) },
    siteProfile: {
      // No row at all until something is written.
      findUnique: async () =>
        store.updatedAt === null
          ? null
          : { brand: store.brand, representation: store.representation, updatedAt: store.updatedAt },
      upsert: async ({ update }: { update: { brand: unknown; representation: unknown } }) => {
        store.brand = update.brand;
        store.representation = update.representation;
        store.updatedAt = new Date("2026-11-25T09:00:00Z");
        return {};
      },
    },
  },
}));
vi.mock("@/lib/session-helper", () => ({ getUserIdFromCookies: mocks.getUserId }));
vi.mock("@/lib/auth/research-action-access", () => ({ userOwnsSite: mocks.ownsSite }));

const { GET, PUT } = await import("@/app/api/sites/[siteId]/brand/route");

function call(fn: typeof GET, body?: unknown) {
  return fn(
    new Request("https://crawlseo.test/api/sites/site_1/brand", {
      method: body === undefined ? "GET" : "PUT",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ siteId: "site_1" }) },
  );
}

const LOGO = {
  assetId: "logo_susi",
  path: "brands/susimacdonald/logo/susi-logo.png",
  url: null,
  alt: "Susana MacDonald",
  hasText: true,
  width: 500,
  height: 150,
};

const BRAND = {
  name: "Susana MacDonald",
  colors: { ink: "#111111", sand: "#C9B79C" },
  fonts: { display: "Playfair Display", body: "Montserrat", mono: "" },
  voice: { sample: "Playa del Carmen, not the postcard version.", tone: ["calm", "precise"] },
  persona: {
    positioning: "Property for buyers whose first job is to keep what they already have.",
    audience: "North American buyers moving savings into Mexico.",
    promise: "Title, zoning, build quality and resale as one decision.",
    avoids: ["postcard glamour", "get-rich-quick"],
  },
  notes: "",
};

beforeEach(() => {
  store.brand = null;
  store.representation = null;
  store.updatedAt = null;
  mocks.getUserId.mockResolvedValue("operator-1");
  mocks.ownsSite.mockResolvedValue(true);
});

describe("brand profile route", () => {
  it("refuses a caller with no session", async () => {
    mocks.getUserId.mockResolvedValue(null);
    expect((await call(GET)).status).toBe(401);
  });

  it("answers 404 for a site the caller does not own, not 403", async () => {
    mocks.ownsSite.mockResolvedValue(false);
    expect((await call(GET)).status).toBe(404);
  });

  it("reports an empty profile as unconfigured rather than inventing a brand", async () => {
    const body = await (await call(GET)).json();
    expect(body).toEqual({ brand: null, configured: false, revision: null });
  });

  it("saves the persona and reads it back", async () => {
    const saved = await call(PUT, BRAND);
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.brand.persona).toEqual(BRAND.persona);
    expect(body.revision).toMatch(/^sha256:/);

    const read = await (await call(GET)).json();
    expect(read.configured).toBe(true);
    expect(read.brand.persona.audience).toContain("moving savings into Mexico");
    expect(read.brand.colors).toEqual({ ink: "#111111", sand: "#c9b79c" });
  });

  it("cannot erase what the brand is allowed to promote", async () => {
    store.representation = parseSiteRepresentation({
      entries: [{ kind: "project", name: "Distrito Xcalacoco", aliases: [], url: null, note: "" }],
      serviceArea: { countries: ["MX"], regions: [], places: [] },
    });
    store.updatedAt = new Date("2026-11-20T10:00:00Z");
    await call(PUT, BRAND);
    const brand = store.brand as { persona: { positioning: string } };
    expect(brand.persona.positioning).toContain("keep what they already have");

    const representation = store.representation as ReturnType<typeof parseSiteRepresentation>;
    expect(representation.entries.map((entry) => entry.name)).toEqual(["Distrito Xcalacoco"]);
    expect(representation.serviceArea.countries).toEqual(["MX"]);
  });

  it("keeps a logo the form never showed", async () => {
    store.brand = { ...BRAND, logo: LOGO };
    store.updatedAt = new Date("2026-11-20T10:00:00Z");

    // The panel posts text fields only; `logo` is an uploaded asset.
    const response = await call(PUT, { ...BRAND, logo: undefined });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.brand.logo).toEqual(LOGO);
  });

  it("re-saving what it read changes nothing", async () => {
    // An existing brand, with the logo its upload gave it.
    store.brand = { ...BRAND, logo: LOGO };
    store.updatedAt = new Date("2026-11-20T10:00:00Z");
    const first = await (await call(PUT, BRAND)).json();
    const reread = await (await call(GET)).json();
    const again = await (await call(PUT, reread.brand)).json();
    expect(again.revision).toBe(reread.revision);
    expect(again.brand.logo).toEqual(LOGO);
    expect(first.revision).toBe(reread.revision);
  });

  it("refuses a brand with no name", async () => {
    const response = await call(PUT, { ...BRAND, name: "  " });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("name");
    expect(store.brand).toBeNull();
  });

  it("refuses a colour that is not a hex value, and says which field", async () => {
    const response = await call(PUT, { ...BRAND, colors: { ink: "near-black" } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("colors.ink");
    expect(store.brand).toBeNull();
  });

  it("refuses a colour name the renderer would silently drop", async () => {
    const response = await call(PUT, { ...BRAND, colors: { "not a name!": "#111111" } });
    expect(response.status).toBe(400);
  });

  it("fills a brand block that only has a name", async () => {
    const response = await call(PUT, { name: "Susana MacDonald" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.brand).toMatchObject({
      persona: { positioning: "", audience: "", promise: "", avoids: [] },
      colors: {},
      voice: { sample: "", tone: [] },
    });
  });
});
