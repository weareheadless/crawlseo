"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Profile = {
  source: string;
  repoPath: string | null;
  palette: string[];
  fonts: string[];
  notes: string;
  scannedFiles: number;
  skippedFiles: number;
  updatedAt: string;
};

export function DesignProfileForm({
  siteId,
  initial,
}: {
  siteId: string;
  initial: Profile | null;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(initial);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function save(body: Record<string, unknown>, label: string) {
    setSaving(label);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch(`/crawlseo/api/sites/${siteId}/design-profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not save the design profile");
      if (payload.profile) {
        setProfile(payload.profile as Profile);
        setNotes((payload.profile as Profile).notes ?? "");
      }
      setMessage(label === "refresh" ? "Design facts refreshed from the repository." : "Design notes saved.");
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save the design profile");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="panel space-y-4 p-5">
      <div>
        <h2 className="font-heading text-lg font-semibold">Design reference</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The page agent reads these facts before designing. The palette and fonts are extracted from the source
          repository; the notes are yours.
        </p>
      </div>

      {profile?.palette.length ? (
        <div className="flex flex-wrap gap-2">
          {profile.palette.map((color) => (
            <span key={color} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-data text-[10px]">
              <span className="size-3 rounded-sm border border-border" style={{ backgroundColor: color }} />
              {color}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No palette extracted yet.</p>
      )}

      {profile?.fonts.length ? (
        <p className="text-xs text-muted-foreground">
          Fonts: <span className="text-foreground">{profile.fonts.join(", ")}</span>
        </p>
      ) : null}

      <label className="block text-sm">
        Design notes
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          placeholder="Use the plum #87475b for headings, cream #faf6ee for page backgrounds, Libre Caslon Text for headings, generous 48–80px section spacing, thin 1px rules, no rounded cards."
          className="mt-1 block w-full rounded-lg border border-border bg-background p-2 text-sm"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => save({ notes }, "save")} disabled={saving !== null}>
          {saving === "save" ? "Saving…" : "Save notes"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => save({ refresh: true }, "refresh")} disabled={saving !== null}>
          {saving === "refresh" ? "Reading repository…" : "Refresh from repository"}
        </Button>
        {profile && (
          <span className="text-[10px] text-muted-foreground">
            {profile.scannedFiles} files scanned{profile.skippedFiles ? `, ${profile.skippedFiles} skipped` : ""} · {profile.source}
            {profile.repoPath ? ` · ${profile.repoPath}` : ""}
          </span>
        )}
      </div>

      {message && (
        <p role={failed ? "alert" : "status"} className="text-xs text-muted-foreground">{message}</p>
      )}
    </section>
  );
}
