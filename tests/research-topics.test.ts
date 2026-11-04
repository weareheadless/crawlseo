import { describe, expect, it } from "vitest";

import { placeToken } from "@/lib/tenants/analysis";

/**
 * Casamigo's research topics were "property listings Calle Juan de la Barrera" and
 * "lead generation Calle Juan de la Barrera": an office street appended to every
 * service, producing queries nobody searches in a market the business does not
 * serve.
 */
describe("research place token", () => {
  it("rejects a street address", () => {
    expect(placeToken("Calle Juan de la Barrera")).toBeNull();
    expect(placeToken("12 Rue des Fleurs")).toBeNull();
    expect(placeToken("221B Baker Street")).toBeNull();
    expect(placeToken("Paseo de la Reforma 500")).toBeNull();
  });

  it("keeps a locality or region", () => {
    expect(placeToken("Playa del Carmen")).toBe("Playa del Carmen");
    expect(placeToken("Normandie")).toBe("Normandie");
    expect(placeToken("Tulum, Quintana Roo")).toBe("Tulum");
  });

  it("uses the first segment of a full address", () => {
    expect(placeToken("Playa del Carmen, Quintana Roo, Mexico")).toBe("Playa del Carmen");
  });

  it("returns null for empty or implausible values", () => {
    expect(placeToken(null)).toBeNull();
    expect(placeToken("   ")).toBeNull();
    expect(placeToken("a".repeat(60))).toBeNull();
  });
});
