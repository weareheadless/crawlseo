import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

import { BrandProfileForm } from "@/components/settings/brand-profile-form";
import type { SiteBrand } from "@/lib/site/brand";

/**
 * The screen is how a human writes the brief the renderer reads. What is
 * asserted here is that the fields exist and hold the stored values; the route
 * test covers what saving does with them.
 */

const BRAND: SiteBrand = {
  schemaVersion: "brand/1",
  name: "Susana MacDonald",
  logo: null,
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

function render(initial: SiteBrand | null) {
  return renderToStaticMarkup(<BrandProfileForm siteId="site_1" initial={initial} />);
}

describe("brand profile screen", () => {
  it("shows the stored persona, voice and palette", () => {
    const html = render(BRAND);
    expect(html).toContain("Property for buyers whose first job is to keep what they already have.");
    expect(html).toContain("North American buyers moving savings into Mexico.");
    expect(html).toContain("postcard glamour");
    expect(html).toContain("Playa del Carmen, not the postcard version.");
    expect(html).toContain("calm, precise");
    expect(html).toContain("#C9B79C");
    expect(html).toContain("Playfair Display");
  });

  it("asks for the same fields before a brand exists", () => {
    const html = render(null);
    expect(html).toContain("Brand profile");
    expect(html).toContain("What it is for");
    expect(html).toContain("Who reads it");
    expect(html).toContain("What it is not");
  });
});
