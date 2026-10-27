"use client";
import { useState } from "react";
export function PrelaunchDeriveButton({ projectId, runId }: { projectId: string; runId: string }) {
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function derive() { setBusy(true); try { const res = await fetch(`/api/projects/${projectId}/prelaunch-research/${runId}/actions`, { method: "POST" }); const data = await res.json(); if (!res.ok) throw new Error(data.error); setMessage(`${data.created} created · ${data.existing} existing${data.reason ? ` · ${data.reason}` : ""}`); } catch (e) { setMessage(e instanceof Error ? e.message : "Could not derive Actions"); } finally { setBusy(false); } }
  return <div><button onClick={derive} disabled={busy} className="rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50">{busy ? "Checking…" : "Derive Actions from stored results"}</button>{message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}</div>;
}
