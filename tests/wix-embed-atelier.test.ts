import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { rebuildAtelierEarlyPacket } from "@/lib/delivery/wix-embed";

function packet(key: string, source: string) {
  return gzipSync(Buffer.from(source, "utf8")).toString("base64");
}

describe("Atelier early packet", () => {
  it("replaces the matching packet key and preserves the others", () => {
    const oldNavbar = packet("navbar", "old navbar source");
    const oldFooter = packet("footer", "footer source");
    const html = `<script>(window.__atelierPacketsV51||(window.__atelierPacketsV51=[])).push({"key":"navbar","index":0,"count":2,"encoded":"${oldNavbar}"});(window.__atelierPacketsV51||(window.__atelierPacketsV51=[])).push({"key":"footer","index":1,"count":2,"encoded":"${oldFooter}"});window.__atelierDrainV51?.();</script>`;

    const next = rebuildAtelierEarlyPacket(html, "navbar", "new navbar source");
    const match = next.match(/"key":"navbar"[^}]*?"encoded":"([A-Za-z0-9+/=]+)"/);
    expect(match).toBeTruthy();
    expect(gunzipSync(Buffer.from(match![1], "base64")).toString("utf8")).toBe("new navbar source");
    expect(next).toContain(oldFooter);
  });

  it("fails when the packet key is missing", () => {
    expect(() => rebuildAtelierEarlyPacket("<script></script>", "navbar", "source"))
      .toThrow("Atelier packet key navbar");
  });
});
