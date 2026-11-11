"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Locale = { code: string; prefix: string; query: string | null };

function toLines(locales: { default: string; variants: Locale[] } | null): string {
  if (!locales) return "";
  return locales.variants
    .map((variant) => [variant.code, variant.prefix, variant.query ?? ""].join(" | "))
    .join("\n");
}

function fromLines(value: string): Locale[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [code = "", prefix = "", query = ""] = line.split("|").map((part) => part.trim());
      return { code, prefix, query: query || null };
    });
}

/**
 * The site's published languages. A page task writes one native page per
 * locale, so this list decides how many pages one task produces.
 */
export function LocaleConfigForm({
  siteId,
  initial,
}: {
  siteId: string;
  initial: { default: string; variants: Locale[] } | null;
}) {
  const router = useRouter();
  const [defaultCode, setDefaultCode] = useState(initial?.default ?? "");
  const [lines, setLines] = useState(toLines(initial));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function save() {
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch(`/crawlseo/api/sites/${siteId}/locales`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default: defaultCode.trim(), variants: fromLines(lines) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not save the locale list");
      setMessage("Locales saved. New page tasks will write one page per locale.");
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save the locale list");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel space-y-4 p-5">
      <div>
        <h2 className="font-heading text-lg font-semibold">Published locales</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One line per language: <code className="font-data">code | path prefix | query</code>. A page task writes the
          page from scratch in each language, not a translation.
        </p>
      </div>

      <label className="block text-sm">
        Default locale
        <input
          value={defaultCode}
          onChange={(event) => setDefaultCode(event.target.value)}
          placeholder="fr"
          className="mt-1 block w-32 rounded-lg border border-border bg-background p-2 font-data text-sm"
        />
      </label>

      <label className="block text-sm">
        Locales
        <textarea
          value={lines}
          onChange={(event) => setLines(event.target.value)}
          rows={4}
          placeholder={"fr |  |\nen | /en |"}
          className="mt-1 block w-full rounded-lg border border-border bg-background p-2 font-data text-sm"
        />
        <span className="mt-1 block text-[10px] text-muted-foreground">
          A prefix adds a path segment (<code className="font-data">/en</code>). A query keeps one route and selects the
          language in the URL (<code className="font-data">lang=es</code>).
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save locales"}
        </Button>
        {message && <p role={failed ? "alert" : "status"} className="text-xs text-muted-foreground">{message}</p>}
      </div>
    </section>
  );
}
