"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { SiteBrand } from "@/lib/site/brand";

/**
 * The brand block, edited by a human.
 *
 * Two halves. The identity half (name, palette, type, voice) is what every
 * render needs. The persona half is what the designer argues with: who the
 * reader is, what they are protecting, and what this brand must not become.
 * A brand with no persona still renders — it just comes back as a photograph
 * with a headline under it, because there is nothing else to work from.
 */

type Draft = {
  name: string;
  colors: Array<{ name: string; value: string }>;
  fonts: { display: string; body: string; mono: string };
  voice: { sample: string; tone: string };
  persona: { positioning: string; audience: string; promise: string; avoids: string };
  notes: string;
};

function draftFrom(brand: SiteBrand | null): Draft {
  return {
    name: brand?.name ?? "",
    colors: Object.entries(brand?.colors ?? {}).map(([name, value]) => ({ name, value })),
    fonts: {
      display: brand?.fonts.display ?? "",
      body: brand?.fonts.body ?? "",
      mono: brand?.fonts.mono ?? "",
    },
    voice: {
      sample: brand?.voice.sample ?? "",
      tone: (brand?.voice.tone ?? []).join(", "),
    },
    persona: {
      positioning: brand?.persona.positioning ?? "",
      audience: brand?.persona.audience ?? "",
      promise: brand?.persona.promise ?? "",
      avoids: (brand?.persona.avoids ?? []).join("\n"),
    },
    notes: brand?.notes ?? "",
  };
}

/** "calm, precise" → ["calm", "precise"]; one per line for the avoids list. */
function byComma(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function byLine(value: string): string[] {
  return value.split("\n").map((entry) => entry.trim()).filter(Boolean);
}

export function BrandProfileForm({
  siteId,
  initial,
}: {
  siteId: string;
  initial: SiteBrand | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function setNested<S extends "fonts" | "voice" | "persona">(
    section: S,
    key: keyof Draft[S],
    value: string,
  ) {
    setDraft((current) => ({ ...current, [section]: { ...current[section], [key]: value } }));
  }

  function setColour(index: number, patch: Partial<{ name: string; value: string }>) {
    setDraft((current) => ({
      ...current,
      colors: current.colors.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
    }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      const colors: Record<string, string> = {};
      for (const entry of draft.colors) {
        if (!entry.name.trim() || !entry.value.trim()) continue;
        colors[entry.name.trim().toLowerCase()] = entry.value.trim().toLowerCase();
      }
      const response = await fetch(`/crawlseo/api/sites/${siteId}/brand`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          colors,
          fonts: draft.fonts,
          voice: { sample: draft.voice.sample, tone: byComma(draft.voice.tone) },
          persona: {
            positioning: draft.persona.positioning,
            audience: draft.persona.audience,
            promise: draft.persona.promise,
            avoids: byLine(draft.persona.avoids),
          },
          notes: draft.notes,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not save the brand profile");
      if (payload.brand) setDraft(draftFrom(payload.brand as SiteBrand));
      setMessage("Brand profile saved. The next cover is designed from it.");
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save the brand profile");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="panel space-y-5 p-5">
      <div>
        <h2 className="font-heading text-lg font-semibold">Brand profile</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The renderer reads this on every cover. The persona is the brief: what the brand is for, who reads it,
          and what it must not become.
        </p>
      </div>

      <label className="block text-sm">
        Name
        <input
          value={draft.name}
          onChange={(event) => set("name", event.target.value)}
          placeholder="Susana MacDonald"
          className="mt-1 block w-full rounded-lg border border-border bg-background p-2 font-data text-sm"
        />
      </label>

      <fieldset className="space-y-3 border-t border-border pt-4">
        <legend className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">The brief</legend>
        <label className="block text-sm">
          What it is for
          <textarea
            value={draft.persona.positioning}
            onChange={(event) => setNested("persona", "positioning", event.target.value)}
            rows={3}
            placeholder="Property for buyers whose first job is to keep what they already have."
            className="mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          Who reads it
          <textarea
            value={draft.persona.audience}
            onChange={(event) => setNested("persona", "audience", event.target.value)}
            rows={3}
            placeholder="North American buyers moving savings into Mexico."
            className="mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          What it is trusted with
          <textarea
            value={draft.persona.promise}
            onChange={(event) => setNested("persona", "promise", event.target.value)}
            rows={2}
            placeholder="Title, zoning, build quality and resale as one decision."
            className="mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          What it is not
          <textarea
            value={draft.persona.avoids}
            onChange={(event) => setNested("persona", "avoids", event.target.value)}
            rows={3}
            placeholder={"postcard glamour\nget-rich-quick"}
            className="mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
          <span className="mt-1 block text-[10px] text-muted-foreground">One per line.</span>
        </label>
      </fieldset>

      <fieldset className="space-y-3 border-t border-border pt-4">
        <legend className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Voice</legend>
        <label className="block text-sm">
          A line it has written
          <textarea
            value={draft.voice.sample}
            onChange={(event) => setNested("voice", "sample", event.target.value)}
            rows={2}
            placeholder="Playa del Carmen, not the postcard version."
            className="mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          Tone
          <input
            value={draft.voice.tone}
            onChange={(event) => setNested("voice", "tone", event.target.value)}
            placeholder="calm, precise, warm, local"
            className="mt-1 block w-full rounded-lg border border-border bg-background p-2 font-data text-sm"
          />
          <span className="mt-1 block text-[10px] text-muted-foreground">Comma separated.</span>
        </label>
      </fieldset>

      <fieldset className="space-y-3 border-t border-border pt-4">
        <legend className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Palette and type</legend>
        <div className="space-y-2">
          {draft.colors.length === 0 ? (
            <p className="text-xs text-muted-foreground">No colours yet.</p>
          ) : null}
          {draft.colors.map((entry, index) => (
            <div key={`${entry.name}-${index}`} className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-5 shrink-0 rounded-sm border border-border"
                style={{ backgroundColor: /^#[0-9a-fA-F]{3,6}$/.test(entry.value) ? entry.value : "transparent" }}
              />
              <input
                value={entry.name}
                onChange={(event) => setColour(index, { name: event.target.value })}
                placeholder="ink"
                aria-label={`Colour ${index + 1} name`}
                className="w-32 rounded-lg border border-border bg-background p-2 font-data text-sm"
              />
              <input
                value={entry.value}
                onChange={(event) => setColour(index, { value: event.target.value })}
                placeholder="#111111"
                aria-label={`Colour ${index + 1} value`}
                className="w-32 rounded-lg border border-border bg-background p-2 font-data text-sm"
              />
              <button
                type="button"
                onClick={() => set("colors", draft.colors.filter((_, at) => at !== index))}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => set("colors", [...draft.colors, { name: "", value: "" }])}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            + Add colour
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {(["display", "body", "mono"] as const).map((role) => (
            <label key={role} className="block text-sm">
              {role === "display" ? "Display" : role === "body" ? "Body" : "Accent"}
              <input
                value={draft.fonts[role]}
                onChange={(event) => setNested("fonts", role, event.target.value)}
                placeholder="Playfair Display"
                className="mt-1 block w-full rounded-lg border border-border bg-background p-2 font-data text-sm"
              />
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-sm">
        Notes
        <textarea
          value={draft.notes}
          onChange={(event) => set("notes", event.target.value)}
          rows={2}
          className="mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm"
        />
      </label>

      {message && (
        <p role={failed ? "alert" : "status"} className="text-xs text-muted-foreground">{message}</p>
      )}
      <Button disabled={saving || !draft.name.trim()}>
        {saving ? "Saving…" : "Save brand profile"}
      </Button>
    </form>
  );
}
