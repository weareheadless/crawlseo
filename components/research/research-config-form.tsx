"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Save } from "lucide-react";

type Config = {
  exclusions: string[];
  recencyDays: number;
  providers: string[];
  maxSources: number;
  revision: number;
  profileUpdatedAt: string | null;
};

const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/55 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function ResearchConfigForm({ siteId, initial }: { siteId: string; initial: Config }) {
  const router = useRouter();
  const [config, setConfig] = useState(initial);
  const [exclusions, setExclusions] = useState(initial.exclusions.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const exclusionList = exclusions.split(",").map((item) => item.trim()).filter(Boolean);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/crawlseo/api/sites/${siteId}/research-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: "research", values: { providers: config.providers, exclusions: exclusionList, recencyDays: config.recencyDays, maxSources: config.maxSources }, expectedPolicyRevision: config.revision, expectedProfileUpdatedAt: config.profileUpdatedAt }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not save research config");
      setNotice("Research configuration saved.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save research config");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="panel space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Excluded topics (comma separated)"><input value={exclusions} onChange={(event) => setExclusions(event.target.value)} className={inputClass} /></Field>
        <Field label="Recency window (days)"><input type="number" min={1} max={3650} value={config.recencyDays} onChange={(event) => setConfig({ ...config, recencyDays: Number(event.target.value) })} className={inputClass} /></Field>
        <Field label="Max sources">
          <input type="number" min={1} max={100} value={config.maxSources} onChange={(event) => setConfig({ ...config, maxSources: Number(event.target.value) })} className={inputClass} />
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Sources</p>
        <div className="flex flex-wrap gap-4">
          {(["reddit", "news"] as const).map((provider) => (
            <Toggle
              key={provider}
              label={provider.charAt(0).toUpperCase() + provider.slice(1)}
              checked={config.providers.includes(provider)}
              onChange={(checked) => setConfig({
                ...config,
                providers: checked
                  ? [...config.providers, provider]
                  : config.providers.filter((item) => item !== provider),
              })}
            />
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Topics and business context are managed under <a className="text-primary underline" href={`/sites/${siteId}/business`}>Business</a>. Schedules, budgets and execution permissions are managed in <a className="text-primary underline" href={`/sites/${siteId}/settings`}>Settings</a>.</p>
      {error && <p className="text-xs text-danger">{error}</p>}
      {notice && <p className="text-xs text-signal">{notice}</p>}
      <Button type="submit" disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        Save research policy
      </Button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}
