"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  MARKET_SCOPE_LEVELS,
  type MarketScopeConfig,
  type MarketScopeLevel,
} from "@/lib/site/market-scope";

/**
 * Tenant market scope.
 *
 * A site can sell a local service and an international product at the same time.
 * This editor is the owner's setting, not a code branch: the topic map and the
 * AI review read it per offer, so a lamp can be proposed internationally while
 * the upholstery service stays local.
 */
export function MarketScopeEditor({
  siteId,
  initial,
  profileUpdatedAt,
  revision,
}: {
  siteId: string;
  initial: MarketScopeConfig;
  profileUpdatedAt: string | null;
  revision: number;
}) {
  const router = useRouter();
  const [values, setValues] = useState<MarketScopeConfig>(initial);
  const [baseline, setBaseline] = useState<MarketScopeConfig>(initial);
  const [preconditions, setPreconditions] = useState({ profileUpdatedAt, revision });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const updateOffer = (index: number, patch: Partial<MarketScopeConfig["offers"][number]>) => {
    setValues({
      ...values,
      offers: values.offers.map((offer, current) => (current === index ? { ...offer, ...patch } : offer)),
    });
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      if (JSON.stringify(values) === JSON.stringify(baseline)) throw new Error("No changes to save.");
      const response = await fetch(`/crawlseo/api/sites/${siteId}/research-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "business",
          values: { marketScope: values },
          expectedPolicyRevision: preconditions.revision,
          expectedProfileUpdatedAt: preconditions.profileUpdatedAt,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "Configuration changed elsewhere. Reload this page before saving again."
            : result.error ?? "Could not save market scope"
        );
      }
      setBaseline(values);
      setPreconditions({
        profileUpdatedAt: result.profileUpdatedAt ?? preconditions.profileUpdatedAt,
        revision: result.policyRevision ?? preconditions.revision,
      });
      setMessage("Market scope saved. The next topic map and AI review will use it.");
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save market scope");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="panel space-y-4 p-4 sm:p-5">
      <div>
        <h2 className="font-heading text-lg font-semibold">Market scope by offer</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Not every offer serves the same market. A restoration service can be local while a product range sells
          nationally or internationally. The topic map and the AI review read this per offer; the owner decides
          what to do with the result.
        </p>
      </div>

      <label className="block max-w-xs">
        <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Default scope</span>
        <select
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          value={values.default}
          onChange={(event) => setValues({ ...values, default: event.target.value as MarketScopeLevel })}
        >
          {MARKET_SCOPE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-3">
        {values.offers.map((offer, index) => (
          <div key={index} className="grid gap-2 rounded-lg border border-border/60 bg-background/40 p-3 sm:grid-cols-[1.2fr_0.8fr_1.2fr_auto]">
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Offer</span>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={offer.offer}
                onChange={(event) => updateOffer(index, { offer: event.target.value })}
                placeholder="Restauration de siège"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Scope</span>
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={offer.scope}
                onChange={(event) => updateOffer(index, { scope: event.target.value as MarketScopeLevel })}
              >
                {MARKET_SCOPE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Markets (comma separated)</span>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={offer.markets.join(", ")}
                onChange={(event) =>
                  updateOffer(index, {
                    markets: event.target.value.split(",").map((market) => market.trim()).filter(Boolean),
                  })
                }
                placeholder="Normandie, France, Europe"
              />
            </label>
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setValues({ ...values, offers: values.offers.filter((_, current) => current !== index) })}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setValues({
              ...values,
              offers: [...values.offers, { offer: "", scope: values.default, markets: [] }],
            })
          }
        >
          Add offer
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save market scope"}
        </Button>
      </div>

      {message && (
        <p className="text-xs text-muted-foreground" role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}
    </form>
  );
}
