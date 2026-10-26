import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertWixEmbedExecutionBinding,
  rebuildAtelierEarlyPacket,
  wixEmbedEffectToken,
  wixEmbedReadbackMatches,
} from "@/lib/delivery/wix-embed";

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

describe("Wix embed effect receipts", () => {
  it("binds a confirmation to the exact effect fields", () => {
    const effect = { taskId: "task-1", actionRevision: 3, snippetId: "snippet-1", desiredHtmlSha256: "abc" };
    expect(wixEmbedEffectToken(effect)).toBe(wixEmbedEffectToken({ ...effect }));
    expect(wixEmbedEffectToken(effect)).not.toBe(wixEmbedEffectToken({ ...effect, snippetId: "snippet-2" }));
    expect(wixEmbedEffectToken(effect)).not.toBe(wixEmbedEffectToken({ ...effect, actionRevision: 4 }));
  });

  it("requires exact readback content to reconcile an embed effect", () => {
    expect(wixEmbedReadbackMatches("expected HTML", wixEmbedEffectToken({ html: "expected HTML" }))).toBe(false);
    const hash = createHash("sha256").update("expected HTML").digest("hex");
    expect(wixEmbedReadbackMatches("expected HTML", hash)).toBe(true);
    expect(wixEmbedReadbackMatches("changed HTML", hash)).toBe(false);
  });

  it("rejects stale Action revisions and changed or non-owning bindings", () => {
    const task = { actionId: "action-1", actionRevision: 4, connectorGeneration: 2, action: { revision: 4 } };
    const binding = { id: "binding-1", executor: "crawlseo-agent", generation: 2, status: "ACTIVE" };
    expect(() => assertWixEmbedExecutionBinding(task, binding)).not.toThrow();
    expect(() => assertWixEmbedExecutionBinding({ ...task, action: { revision: 5 } }, binding)).toThrow(/Action revision changed/);
    expect(() => assertWixEmbedExecutionBinding(task, { ...binding, generation: 3 })).toThrow(/binding changed/);
    expect(() => assertWixEmbedExecutionBinding(task, { ...binding, executor: "helloada-agent" })).toThrow(/binding changed/);
  });
});
