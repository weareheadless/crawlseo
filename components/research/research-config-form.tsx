"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Save } from "lucide-react";

type Config = {
  topics: string[];
  audience: string;
  market: string;
  language: string;
  providers: string[];
  cadence: "daily" | "weekly" | "monthly" | "manual";
  enabled: boolean;
  maxSources: number;
  monthlyBudget: number;
  autoDraft: boolean;
  autoAgent: boolean;
};

const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/55 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function ResearchConfigForm({ siteId, initial }: { siteId: string; initial: Config }) {
  const router = useRouter();
  const [config, setConfig] = useState(initial);
  const [topics, setTopics] = useState(initial.topics.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const topicList = topics.split(",").map((item) => item.trim()).filter(Boolean);
    if (topicList.length === 0) {
      setError("Add at least one research topic.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/crawlseo/api/sites/${siteId}/research-policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, topics: topicList }),
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
      <Field label="Research topics">
        <input value={topics} onChange={(event) => setTopics(event.target.value)} className={inputClass} placeholder="Tulum real estate, property ownership" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Audience">
          <input value={config.audience} onChange={(event) => setConfig({ ...config, audience: event.target.value })} className={inputClass} placeholder="international buyers" />
        </Field>
        <Field label="Market">
          <input value={config.market} onChange={(event) => setConfig({ ...config, market: event.target.value })} className={inputClass} placeholder="Mexico" />
        </Field>
        <Field label="Language">
          <input value={config.language} onChange={(event) => setConfig({ ...config, language: event.target.value })} className={inputClass} />
        </Field>
        <Field label="Cadence">
          <select value={config.cadence} onChange={(event) => setConfig({ ...config, cadence: event.target.value as Config["cadence"] })} className={inputClass}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="manual">Manual only</option>
          </select>
        </Field>
        <Field label="Max sources">
          <input type="number" min={1} max={100} value={config.maxSources} onChange={(event) => setConfig({ ...config, maxSources: Number(event.target.value) })} className={inputClass} />
        </Field>
        <Field label="Monthly task budget">
          <input type="number" min={0} max={500} value={config.monthlyBudget} onChange={(event) => setConfig({ ...config, monthlyBudget: Number(event.target.value) })} className={inputClass} />
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
      <div className="flex flex-wrap gap-4">
        <Toggle label="Research enabled" checked={config.enabled} onChange={(enabled) => setConfig({ ...config, enabled })} />
        <Toggle label="Auto-draft content" checked={config.autoDraft} onChange={(autoDraft) => setConfig({ ...config, autoDraft })} />
        <Toggle label="Auto-create agent tasks" checked={config.autoAgent} onChange={(autoAgent) => setConfig({ ...config, autoAgent })} />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {notice && <p className="text-xs text-signal">{notice}</p>}
      <Button type="submit" disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        Save research configuration
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
