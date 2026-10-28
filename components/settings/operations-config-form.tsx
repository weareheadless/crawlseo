"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
type Values = { cadence: string; enabled: boolean; monthlyBudget: number; autoDraft: boolean; autoAgent: boolean; revision: number };
export function OperationsConfigForm({ siteId, initial }: { siteId: string; initial: Values }) {
  const [value, setValue] = useState(initial); const [baseline, setBaseline] = useState(initial); const [message, setMessage] = useState(""); const [failed, setFailed] = useState(false); const [saving, setSaving] = useState(false); const router = useRouter();
  async function save(event: React.FormEvent) { event.preventDefault(); setSaving(true); setMessage(""); setFailed(false); try {
    const values = Object.fromEntries(Object.entries({ cadence: value.cadence, enabled: value.enabled, monthlyBudget: value.monthlyBudget, autoDraft: value.autoDraft, autoAgent: value.autoAgent }).filter(([key, item]) => item !== baseline[key as keyof Values]));
    if (!Object.keys(values).length) throw new Error("No changes to save.");
    const response = await fetch(`/crawlseo/api/sites/${siteId}/research-policy`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ section: "operations", values, expectedPolicyRevision: value.revision }) });
    const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(response.status === 409 ? "Configuration changed elsewhere. Reload this page before saving again." : body.error ?? "Could not save settings");
    const next = { ...value, revision: body.policyRevision ?? value.revision }; setValue(next); setBaseline(next); setMessage("Operations settings saved."); router.refresh();
  } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Could not save settings"); } finally { setSaving(false); } }
  return <form onSubmit={save} className="panel space-y-4 p-5"><div><h2 className="font-heading text-lg font-semibold">Research operations</h2><p className="mt-1 text-sm text-muted-foreground">Schedule, spend limit, and execution permissions for this site.</p></div>
    <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">Cadence<select className="mt-1 block w-full rounded-lg border border-border bg-background p-2" value={value.cadence} onChange={(e) => setValue({ ...value, cadence: e.target.value })}>{["daily", "weekly", "monthly", "manual"].map((item) => <option key={item}>{item}</option>)}</select></label>
    <label className="text-sm">Monthly budget<input type="number" min={0} max={500} className="mt-1 block w-full rounded-lg border border-border bg-background p-2" value={value.monthlyBudget} onChange={(e) => setValue({ ...value, monthlyBudget: Number(e.target.value) })}/></label>
    {(["enabled", "autoDraft", "autoAgent"] as const).map((key) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value[key]} onChange={(e) => setValue({ ...value, [key]: e.target.checked })}/>{key === "enabled" ? "Scheduled research enabled" : key === "autoDraft" ? "Allow automatic drafts" : "Allow automatic agent execution"}</label>)}</div>
    {message && <p role={failed ? "alert" : "status"} className="text-xs text-muted-foreground">{message}</p>}<Button disabled={saving}>{saving ? "Saving…" : "Save operations"}</Button>
  </form>;
}
