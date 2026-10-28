import { describe, expect, it } from "vitest";
import { looksLikeQuestion, questionFromTheme, resolveBrandIdentity } from "@/lib/aeo/brand";

describe("brand identity", () => {
  it("prefers the canonical business name", () => {
    expect(resolveBrandIdentity({ businessName: "Maison Exemple", aliases: ["Exemple", "maison exemple"], domain: "atelier-harmonie.com" }))
      .toEqual({ name: "Maison Exemple", aliases: ["Exemple"] });
  });
  it("uses the recorded project name before the domain", () => {
    expect(resolveBrandIdentity({ projectName: "Susi MacDonald", domain: "www.susimacdonald.com" }).name).toBe("Susi MacDonald");
  });
  it("humanises the site domain when no canonical document exists", () => {
    expect(resolveBrandIdentity({ domain: "https://www.susimacdonald.com/" }).name).toBe("Susimacdonald");
    expect(resolveBrandIdentity({ domain: "atelier-harmonie.com" }).name).toBe("Atelier Harmonie");
  });
  it("returns no invented brand when nothing is recorded", () => {
    expect(resolveBrandIdentity({ domain: null })).toEqual({ name: null, aliases: [] });
  });
});

describe("question quality", () => {
  it("rejects research statements and accepts questions", () => {
    expect(looksLikeQuestion("Three separate news items describe foreign buyers losing money")).toBe(false);
    expect(looksLikeQuestion("Who offers beachfront homes in Mexico?")).toBe(true);
    expect(looksLikeQuestion("Comment choisir un luminaire artisanal ?")).toBe(true);
  });
  it("turns a theme into a buyer question instead of asking the statement", () => {
    expect(questionFromTheme("foreign buyer fraud")).toBe("What should a buyer know about foreign buyer fraud?");
  });
});
