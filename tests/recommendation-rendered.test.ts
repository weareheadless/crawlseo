import { describe, expect, it } from "vitest";

import { retrievePage } from "@/lib/recommendation/packet";

const shell = `<!doctype html><html><head><title>Instant quote</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const renderedText =
  "Every fitted wardrobe quote includes a survey, a written itemised price, delivery and installation. " +
  "The quote is valid for thirty days and the price does not change after the survey unless you change the design.";

function transport() {
  return async () =>
    new Response(shell, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
}

const resolve = async () => ({ address: "93.184.216.34", family: 4 });

describe("rendered retrieval", () => {
  it("reads a client-rendered quote page instead of calling it absent", async () => {
    const page = await retrievePage("https://site.test/quote", "site.test", {
      transport: transport(),
      resolve,
      render: async () => ({
        html: `<html><head><title>Instant quote</title></head><body><p>${renderedText}</p></body></html>`,
        text: renderedText,
        title: "Instant quote",
        bytes: 2_048,
        truncated: false,
      }),
    });
    expect(page.retrieval).toBe("rendered");
    expect(page.text).toContain("itemised price");
    expect(page.title).toBe("Instant quote");
    expect(page.note).toMatch(/client-side render/);
  });

  it("keeps the page unknown when the render is unavailable", async () => {
    const page = await retrievePage("https://site.test/quote", "site.test", {
      transport: transport(),
      resolve,
      render: async () => null,
    });
    expect(page.retrieval).toBe("unavailable");
    expect(page.text).toBe("");
    expect(page.note).toMatch(/client-rendered shell|no usable body text/);
  });
});
