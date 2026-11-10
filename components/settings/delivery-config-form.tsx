"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Adapter = "wix_embed" | "wix_blog" | "manual";

export function DeliveryConfigForm({
  siteId,
  initial,
}: {
  siteId: string;
  initial: { bridgeAlias: string; adapters: Adapter[]; enabled: boolean };
}) {
  const router = useRouter();
  const [bridgeAlias, setBridgeAlias] = useState(initial.bridgeAlias);
  const [adapters, setAdapters] = useState<Adapter[]>(initial.adapters);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function toggle(adapter: Adapter) {
    setAdapters((current) => current.includes(adapter)
      ? current.filter((item) => item !== adapter)
      : [...current, adapter]);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch(`/crawlseo/api/sites/${siteId}/delivery-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bridgeAlias, adapters, enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save the delivery configuration");
      setMessage("Delivery connection saved.");
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save the delivery configuration");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="panel space-y-4 p-5">
      <div>
        <h2 className="font-heading text-lg font-semibold">Delivery connection</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The bridge alias is the site folder in the Wix bridge. The adapters decide which lanes this site can use.
        </p>
      </div>
      <label className="block text-sm">
        Bridge alias
        <input
          value={bridgeAlias}
          onChange={(event) => setBridgeAlias(event.target.value)}
          placeholder="site-alias"
          className="mt-1 block w-full rounded-lg border border-border bg-background p-2 font-data text-sm"
        />
      </label>
      <div className="flex flex-wrap gap-4">
        {(["wix_embed", "wix_blog", "manual"] as const).map((adapter) => (
          <label key={adapter} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={adapters.includes(adapter)} onChange={() => toggle(adapter)} />
            {adapter === "wix_embed" ? "Wix page embeds" : adapter === "wix_blog" ? "Wix Blog articles" : "Manual"}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Delivery enabled
      </label>
      {message && (
        <p role={failed ? "alert" : "status"} className="text-xs text-muted-foreground">{message}</p>
      )}
      <Button disabled={saving || !bridgeAlias.trim() || adapters.length === 0}>
        {saving ? "Saving…" : "Save delivery connection"}
      </Button>
    </form>
  );
}
