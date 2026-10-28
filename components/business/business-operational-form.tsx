"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Values = { topics: string[]; audience: string; market: string; language: string; goals: string[]; services: string[]; competitors: string[]; brandVoice: string };
const fields: { key: keyof Values; label: string; list?: boolean }[] = [
  { key: "topics", label: "Operational topics", list: true }, { key: "audience", label: "Audience" },
  { key: "market", label: "Market" }, { key: "language", label: "Language" }, { key: "goals", label: "Goals", list: true },
  { key: "services", label: "Services", list: true }, { key: "competitors", label: "Competitors", list: true }, { key: "brandVoice", label: "Brand voice" },
];
export function BusinessOperationalForm({ siteId, initial, profileUpdatedAt, revision }: { siteId: string; initial: Values; profileUpdatedAt: string | null; revision: number }) {
  const router = useRouter(); const [values, setValues] = useState(initial); const [baseline, setBaseline] = useState(initial); const [preconditions, setPreconditions] = useState({ profileUpdatedAt, revision }); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(""); const [failed, setFailed] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setMessage(""); setFailed(false);
    try {
      const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline[key as keyof Values])));
      if (!Object.keys(patch).length) throw new Error("No changes to save.");
      const response = await fetch(`/crawlseo/api/sites/${siteId}/research-policy`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ section: "business", values: patch, expectedPolicyRevision: preconditions.revision, expectedProfileUpdatedAt: preconditions.profileUpdatedAt }) });
      const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(response.status === 409 ? "Configuration changed elsewhere. Reload this page before saving again." : result.error ?? "Could not save business context");
      setBaseline(values); setPreconditions({ profileUpdatedAt: result.profileUpdatedAt ?? preconditions.profileUpdatedAt, revision: result.policyRevision ?? preconditions.revision }); setMessage("Operational context saved; canonical facts were not changed."); router.refresh();
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Could not save business context"); } finally { setSaving(false); }
  }
  return <form onSubmit={save} className="panel space-y-4 p-4 sm:p-5">
    <div><h2 className="font-heading text-lg font-semibold">Operational business context</h2><p className="mt-1 text-sm text-muted-foreground">These values guide research and content operations. Saving does not confirm or change canonical business facts.</p></div>
    <div className="grid gap-4 sm:grid-cols-2">{fields.map(({ key, label, list }) => <label key={key} className="block"><span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span><textarea className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" rows={list ? 2 : 3} value={list ? (values[key] as string[]).join("\n") : values[key] as string} onChange={(event) => setValues({ ...values, [key]: list ? event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) : event.target.value })} /></label>)}</div>
    {message && <p className="text-xs text-muted-foreground" role={failed ? "alert" : "status"}>{message}</p>}<Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save operational context"}</Button>
  </form>;
}
