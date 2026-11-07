"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Values = {
  audience: string;
  audienceMarket: string;
  audienceMarkets: string[];
  audienceLanguages: string[];
};

export function AudienceEditor({
  siteId,
  initial,
  profileUpdatedAt,
  revision,
}: {
  siteId: string;
  initial: Values;
  profileUpdatedAt: string | null;
  revision: number;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [preconditions, setPreconditions] = useState({ profileUpdatedAt, revision });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      const patch = Object.fromEntries(
        Object.entries(values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline[key as keyof Values]))
      );
      if (!Object.keys(patch).length) throw new Error("No changes to save.");
      const response = await fetch(`/crawlseo/api/sites/${siteId}/research-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "business",
          values: patch,
          expectedPolicyRevision: preconditions.revision,
          expectedProfileUpdatedAt: preconditions.profileUpdatedAt,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "Configuration changed elsewhere. Reload this page before saving again."
            : result.error ?? "Could not save the target audience"
        );
      }
      setBaseline(values);
      setPreconditions({
        profileUpdatedAt: result.profileUpdatedAt ?? preconditions.profileUpdatedAt,
        revision: result.policyRevision ?? preconditions.revision,
      });
      setMessage("Target audience saved. The next topic taxonomy proposal will use it.");
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save the target audience");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="panel border-primary/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-data text-[9px] uppercase tracking-wide text-primary">Important</p>
          <h2 className="font-heading text-lg font-semibold">Target audience</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Who you serve and where they search. This decides the topic language, the keyword market,
            the SERP location and the AI answers. It is not your business address.
          </p>
        </div>
      </div>

      {!values.audienceMarket && (
        <p className="mt-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          Audience market not set. Research falls back to the business country, so topics may be scoped
          to the wrong audience.
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Who they are</span>
          <textarea
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            rows={2}
            maxLength={300}
            value={values.audience}
            onChange={(event) => setValues({ ...values, audience: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Where they search (audience market)
          </span>
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            maxLength={120}
            placeholder="United States"
            value={values.audienceMarket}
            onChange={(event) => setValues({ ...values, audienceMarket: event.target.value })}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            The country whose Google and keyword data represent your buyers.
          </span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Audience countries</span>
          <textarea
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            rows={2}
            placeholder="US&#10;CA"
            value={values.audienceMarkets.join("\n")}
            onChange={(event) =>
              setValues({
                ...values,
                audienceMarkets: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean),
              })
            }
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            One per line, e.g. US, CA. The first is the primary market.
          </span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Audience languages</span>
          <textarea
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            rows={2}
            placeholder="en&#10;es"
            value={values.audienceLanguages.join("\n")}
            onChange={(event) =>
              setValues({
                ...values,
                audienceLanguages: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean),
              })
            }
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            One per line, e.g. en, es. The language buyers search, not necessarily the site language.
          </span>
        </label>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Changing the audience affects the next topic taxonomy proposal. Existing topics keep their need
        terms until the taxonomy is refreshed.
      </p>
      {message && (
        <p className="mt-2 text-xs text-muted-foreground" role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}
      <Button className="mt-3" type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save target audience"}
      </Button>
    </form>
  );
}
