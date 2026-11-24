import { describe, expect, it } from "vitest";
import {
  emptyRepresentation,
  parseSiteBrand,
  parseSiteRepresentation,
  readSiteBrand,
  representedNames,
  siteBrandRevision,
  type BrandReadDb,
} from "@/lib/site/brand";

const LOGO = { path: "brands/susimacdonald/logo/susi-logo.png", assetId: "logo_susi", hasText: true, width: 503, height: 167 };

const BRAND = {
  name: "Susi Macdonald",
  logo: LOGO,
  colors: { ink: "#211E1A", sand: "#C9B79C", cream: "#F6F1E7" },
  fonts: { display: "Playfair Display", body: "Montserrat" },
  voice: { sample: "Playa del Carmen, not the postcard version.", tone: ["direct", "specific"] },
};

function stub(profile: unknown): BrandReadDb {
  return { siteProfile: { findUnique: async () => profile } } as unknown as BrandReadDb;
}

describe("brand record", () => {
  it("keeps the logo reference a renderer needs, whole", () => {
    const brand = parseSiteBrand(BRAND);
    expect(brand?.logo).toEqual({ assetId: "logo_susi", path: LOGO.path, url: null, alt: "", hasText: true, width: 503, height: 167 });
  });

  it("drops a logo reference that names neither a path nor a URL", () => {
    // The failure that started this: an empty logo path rendered as a post with
    // no logo at all, and nothing downstream could tell it was missing.
    const brand = parseSiteBrand({ ...BRAND, logo: { assetId: "logo_susi", path: "", url: "" } });
    expect(brand?.logo).toBeNull();
  });

  it("keeps an unknown logo-text flag unknown rather than guessing", () => {
    const brand = parseSiteBrand({ ...BRAND, logo: { path: LOGO.path } });
    expect(brand?.logo?.hasText).toBeNull();
  });

  it("refuses a brand block with no name", () => {
    expect(parseSiteBrand({ ...BRAND, name: "  " })).toBeNull();
    expect(parseSiteBrand({ logo: LOGO })).toBeNull();
  });

  it("normalises colours and drops values that are not colours", () => {
    const brand = parseSiteBrand({ ...BRAND, colors: { ink: "#ABC", sand: "#C9B79C", broken: "sand", "not a name!": "#fff" } });
    expect(brand?.colors).toEqual({ ink: "#aabbcc", sand: "#c9b79c" });
  });

  it("refuses a font family that is really a pattern fragment", () => {
    const brand = parseSiteBrand({ ...BRAND, fonts: { display: "font-family: {display}", body: "Montserrat" } });
    expect(brand?.fonts).toEqual({ display: "", body: "Montserrat", mono: "" });
  });

  it("is not configured when the profile has only a design scan", () => {
    // `design` is what the stylesheet scanner found. It prefills the block for a
    // human; rendering from it would put a guessed palette on a post.
    const brand = parseSiteBrand({ palette: ["#211e1a"], fonts: ["Playfair Display"], notes: "scanned" });
    expect(brand).toBeNull();
  });

  it("reports a profile with no brand block as unconfigured, not as an empty brand", async () => {
    const record = await readSiteBrand(stub({ brand: null, representation: null, updatedAt: new Date("2026-11-24T10:00:00Z") }), "site_1");
    expect(record).toMatchObject({ siteId: "site_1", brand: null, configured: false });
    expect(record?.representation).toEqual(emptyRepresentation());
    expect(record?.updatedAt).toBe("2026-11-24T10:00:00.000Z");
  });

  it("returns null when the site has no profile at all", async () => {
    expect(await readSiteBrand(stub(null), "site_1")).toBeNull();
  });
});

describe("brand revision", () => {
  it("is stable across key order", () => {
    const first = parseSiteBrand(BRAND)!;
    const reordered = parseSiteBrand({ fonts: BRAND.fonts, colors: BRAND.colors, name: BRAND.name, voice: BRAND.voice, logo: LOGO })!;
    expect(siteBrandRevision(first, emptyRepresentation())).toBe(siteBrandRevision(reordered, emptyRepresentation()));
  });

  it("changes when the logo changes, so a cache cannot outlive it", () => {
    const before = siteBrandRevision(parseSiteBrand(BRAND), emptyRepresentation());
    const after = siteBrandRevision(parseSiteBrand({ ...BRAND, logo: { ...LOGO, path: "brands/susimacdonald/logo/susi-logo-v2.png" } }), emptyRepresentation());
    const withoutLogo = siteBrandRevision(parseSiteBrand({ ...BRAND, logo: null }), emptyRepresentation());
    expect(after).not.toBe(before);
    expect(withoutLogo).not.toBe(before);
  });

  it("changes when representation changes", () => {
    const brand = parseSiteBrand(BRAND);
    const empty = siteBrandRevision(brand, emptyRepresentation());
    const represented = siteBrandRevision(brand, parseSiteRepresentation({ entries: [{ kind: "project", name: "Kanai" }] }));
    expect(represented).not.toBe(empty);
  });
});

describe("representation", () => {
  it("keeps the kinds the gate can act on and drops anything else", () => {
    const representation = parseSiteRepresentation({
      serviceArea: { countries: ["mx", "US", "Mexico"], regions: ["Riviera Maya"], places: ["Playa del Carmen"] },
      entries: [
        { kind: "project", name: "Casa del Mar", aliases: ["Casa Del Mar", "cdm"] },
        { kind: "developer", name: "Mandarin Oriental", aliases: [] },
        { kind: "partner", name: "Not a kind the gate knows" },
        { kind: "service", name: "  " },
      ],
    });
    expect(representation.entries.map((entry) => entry.name)).toEqual(["Casa del Mar", "Mandarin Oriental"]);
    expect(representation.entries[0].aliases).toEqual(["cdm"]);
    expect(representation.serviceArea.countries).toEqual(["MX", "US"]);
  });

  it("collapses two entries with one name into one subject", () => {
    const representation = parseSiteRepresentation({
      entries: [
        { kind: "project", name: "Kanai" },
        { kind: "developer", name: "kanai" },
      ],
    });
    expect(representation.entries).toHaveLength(1);
  });

  it("gives the eligibility gate one flat list of promotable names", () => {
    const representation = parseSiteRepresentation({
      serviceArea: { places: ["Tulum"] },
      entries: [{ kind: "project", name: "Casa del Mar", aliases: ["CDM"] }, { kind: "service", name: "Buyer representation" }],
    });
    expect(representedNames(representation)).toEqual(["buyer representation", "casa del mar", "cdm", "tulum"]);
  });

  it("names nothing when nothing is recorded, so rejection stays the default", () => {
    expect(representedNames(emptyRepresentation())).toEqual([]);
  });
});
