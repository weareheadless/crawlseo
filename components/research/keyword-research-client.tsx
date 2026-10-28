"use client";

import {
  Search,
  Loader2,
  Bookmark,
  Check,
  AlertTriangle,
  ListPlus,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const SORTABLE = ["keyword", "volume", "difficulty", "cpc"] as const;

function storedRowLabel(run: { keywordCount: number | null; resultLabel: string }): string {
  const count = run.keywordCount;
  if (count == null) return "—";
  if (run.resultLabel === "SERP results") return `${count} SERP result${count === 1 ? "" : "s"}`;
  return `${count} keyword${count === 1 ? "" : "s"}`;
}
type SortKey = (typeof SORTABLE)[number];

type KeywordResult = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  trend: number[] | null;
  intent?: string | null;
};

export function KeywordResearchClient({
  siteId,
  hasDataForSEO,
  runs = [],
  selectedRunId = null,
  selectedResult = null,
}: {
  siteId: string;
  hasDataForSEO: boolean;
  runs?: Array<{
    id: string;
    seed: string;
    kind: string;
    status: string;
    completedAt: string | null;
    requestedAt: string;
    costMicros: number | null;
    errorCode: string | null;
    keywordCount: number | null;
    resultLabel: string;
    keywords: KeywordResult[];
  }>;
  selectedRunId?: string | null;
  selectedResult?: unknown;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = runs.find((run) => run.id === (searchParams.get("run") || selectedRunId));
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "volume", desc: true });
  const storedKeywords = useMemo(() => {
    if (!selected || selected.status !== "COMPLETED" || !Array.isArray(selectedResult)) return [];
    return [...selectedResult as KeywordResult[]].sort((a, b) => { const av = a[sort.key] ?? (sort.desc ? -Infinity : Infinity), bv = b[sort.key] ?? (sort.desc ? -Infinity : Infinity); return (typeof av === "string" ? av.localeCompare(String(bv)) : Number(av) - Number(bv)) * (sort.desc ? -1 : 1); });
  }, [selected, selectedResult, sort]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<KeywordResult[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [savedSet, setSavedSet] = useState<Set<string>>(new Set());
  const [savingSet, setSavingSet] = useState<Set<string>>(new Set());
  const [queuedSet, setQueuedSet] = useState<Set<string>>(new Set());
  const [queuedActionIds, setQueuedActionIds] = useState<Record<string, string>>({});
  const [queuingSet, setQueuingSet] = useState<Set<string>>(new Set());
  const [queueError, setQueueError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setResults([]);
    setSource(null);

    try {
      const res = await fetch(
        `/crawlseo/api/sites/${siteId}/keyword-research?q=${encodeURIComponent(query.trim())}`
      );
      const data = await res.json();
      setResults(data.keywords ?? []);
      setSource(data.source ?? null);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleQueueAction(result: KeywordResult) {
    setQueuingSet((prev) => new Set(prev).add(result.keyword));
    setQueueError(null);
    try {
      const response = await fetch(`/crawlseo/api/sites/${siteId}/keyword-research/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: result.keyword,
          volume: result.volume,
          difficulty: result.difficulty,
          cpc: result.cpc,
          competition: result.competition,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to queue keyword action");
      const actionId = payload.action?.id;
      setQueuedSet((prev) => new Set(prev).add(result.keyword));
      if (typeof actionId === "string") {
        setQueuedActionIds((prev) => ({ ...prev, [result.keyword]: actionId }));
      }
    } catch (caught) {
      setQueueError(caught instanceof Error ? caught.message : "Failed to queue keyword action");
    } finally {
      setQueuingSet((prev) => {
        const next = new Set(prev);
        next.delete(result.keyword);
        return next;
      });
    }
  }

  async function handleSave(keyword: string) {
    setSavingSet((prev) => new Set(prev).add(keyword));

    try {
      const res = await fetch(`/crawlseo/api/sites/${siteId}/saved-keywords`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: keyword }),
      });
      if (res.ok) {
        setSavedSet((prev) => new Set(prev).add(keyword));
      }
    } catch {
      // ignore
    } finally {
      setSavingSet((prev) => {
        const next = new Set(prev);
        next.delete(keyword);
        return next;
      });
    }
  }

  return (
    <div className="space-y-4">
      {runs.length > 0 && (
        <section className="panel overflow-hidden">
          <div className="border-b border-border/60 p-4">
            <h2 className="font-heading text-lg font-semibold">Stored research runs · {runs.length}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Paid DataForSEO results already recorded for this site. Nothing here triggers a new provider call.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Seed</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 text-right font-medium">Rows</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    onClick={() => router.push(`?run=${encodeURIComponent(run.id)}`)}
                    className={`cursor-pointer border-b border-border/40 transition hover:bg-muted/25 ${
                      selected?.id === run.id ? "bg-muted/40" : ""
                    }`}
                  >
                    <td className="max-w-md px-4 py-2.5">
                      <span className="font-medium">{run.seed}</span>
                      {run.status === "FAILED" && (
                        <span className="ml-2 text-xs text-warning">
                          {run.errorCode?.replaceAll("_", " ").toLowerCase() ?? "unknown error"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-data text-xs text-muted-foreground">{run.kind}</td>
                    <td className="px-4 py-2.5">
                      <span className="rounded-md bg-muted px-1.5 py-0.5 font-data text-[10px] uppercase text-muted-foreground">
                        {run.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {new Date(run.completedAt ?? run.requestedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-data text-xs">
                      {run.status === "FAILED" ? "—" : storedRowLabel(run)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-data text-xs">
                      {run.costMicros == null ? "—" : `$${(run.costMicros / 1_000_000).toFixed(4)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && selected.status === "COMPLETED" && (
            <div className="border-t border-border/60">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
                <p className="text-sm font-medium">
                  {selected.resultLabel} for &ldquo;{selected.seed}&rdquo;
                </p>
                <p className="text-xs text-muted-foreground">
                  {selected.keywordCount ?? 0} stored rows · {selected.kind.toLowerCase().replaceAll("_", " ")}
                </p>
              </div>
              {selected.keywords.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-muted-foreground">
                  {selected.resultLabel === "SERP results"
                    ? "This run stored ranked search results, not a keyword list. It is used as source evidence for content, not as keyword volume data."
                    : "The provider returned no keyword rows for this seed. That is an empty result, not a missing run."}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-y border-border/60 text-left text-xs text-muted-foreground">
                        {SORTABLE.map((key) => (
                          <th key={key} className="px-4 py-2 font-medium">
                            <button
                              type="button"
                              onClick={() =>
                                setSort({ key, desc: sort.key === key ? !sort.desc : key !== "keyword" })
                              }
                              className="uppercase tracking-wide transition hover:text-foreground"
                            >
                              {key} {sort.key === key ? (sort.desc ? "↓" : "↑") : ""}
                            </button>
                          </th>
                        ))}
                        <th className="px-4 py-2 font-medium">INTENT</th>
                        <th className="px-4 py-2 font-medium">COMPETITION</th>
                        <th className="px-4 py-2 font-medium">TREND</th>
                      </tr>
                    </thead>
                    <tbody>
                      {storedKeywords.map((word) => (
                        <tr key={word.keyword} className="border-b border-border/40">
                          <td className="px-4 py-2.5 font-medium">{word.keyword}</td>
                          <td className="px-4 py-2.5 text-right font-data">{word.volume?.toLocaleString() ?? "—"}</td>
                          <td className="px-4 py-2.5 text-right font-data">{word.difficulty ?? "—"}</td>
                          <td className="px-4 py-2.5 text-right font-data">{word.cpc == null ? "—" : `$${word.cpc.toFixed(2)}`}</td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{word.intent ?? "—"}</td>
                          <td className="px-4 py-2.5 text-right font-data text-xs">{word.competition ?? "—"}</td>
                          <td className="px-4 py-2.5 font-data text-xs text-muted-foreground">
                            {word.trend?.length ? `${word.trend[0]} → ${word.trend.at(-1)}` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}
      {/* Autocomplete fallback banner */}
      {!hasDataForSEO && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-medium text-foreground">
              Limited data — Google Autocomplete only
            </p>
            <p className="mt-0.5 text-muted-foreground">
              Add a DataForSEO API key in{" "}
              <Link
                href={`/sites/${siteId}/settings`}
                className="text-primary underline underline-offset-2"
              >
                Settings
              </Link>{" "}
              for search volume, difficulty, and CPC data.
            </p>
          </div>
        </div>
      )}

      <section className="space-y-2">
      <h2 className="font-semibold">On-demand lookup · stored report or free autocomplete</h2>
      <p className="text-sm text-muted-foreground">This lookup reads an existing DataForSEO report when available, then falls back to free Google Autocomplete. It does not make a paid provider call or start a research run.</p>
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter a seed keyword..."
            className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <button
          type="submit"
          disabled={!query.trim() || loading}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          Look up
        </button>
      </form>
      </section>

      {/* Results */}
      {results.length > 0 && (
        <div className="panel overflow-hidden">
          {source && (
            <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
              {source === "autocomplete" ? "Google Autocomplete (free, no volume data)" : source === "article_research" ? "stored keyword research" : "stored DataForSEO report"}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Keyword
                  </th>
                  {source === "dataforseo" && (
                    <>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        Volume
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        Difficulty
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        CPC
                      </th>
                    </>
                  )}
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => {
                  const isSaved = savedSet.has(result.keyword);
                  const isSaving = savingSet.has(result.keyword);

                  return (
                    <tr
                      key={result.keyword}
                      className="border-b border-border/50 transition-colors hover:bg-muted/25"
                    >
                      <td className="max-w-md px-4 py-3">
                        <span className="font-medium text-foreground">
                          {result.keyword}
                        </span>
                      </td>
                      {source === "dataforseo" && (
                        <>
                          <td className="px-4 py-3 text-right font-data text-foreground">
                            {result.volume?.toLocaleString() ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <DifficultyBadge value={result.difficulty} />
                          </td>
                          <td className="px-4 py-3 text-right font-data text-foreground">
                            {result.cpc != null ? `$${result.cpc.toFixed(2)}` : "—"}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleSave(result.keyword)}
                            disabled={isSaved || isSaving}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                          >
                            {isSaved ? (
                              <>
                                <Check className="size-3 text-signal" />
                                Saved
                              </>
                            ) : isSaving ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <>
                                <Bookmark className="size-3" />
                                Save
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleQueueAction(result)}
                            disabled={queuedSet.has(result.keyword) || queuingSet.has(result.keyword)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                          >
                            {queuedSet.has(result.keyword) ? (
                              <>
                                <Check className="size-3 text-signal" />
                                Queued
                              </>
                            ) : queuingSet.has(result.keyword) ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <>
                                <ListPlus className="size-3" />
                                Queue
                              </>
                            )}
                          </button>
                          {queuedActionIds[result.keyword] && (
                            <Link
                              href={`/sites/${siteId}/actions/${queuedActionIds[result.keyword]}`}
                              className="inline-flex items-center rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/10"
                            >
                              Open in Work
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            {results.length} keyword{results.length !== 1 ? "s" : ""} found
            {source === "dataforseo" ? " via stored DataForSEO report" : source === "article_research" ? " via stored keyword research" : " via Google Autocomplete (free, no volume data)"}
          </div>
          {queueError && (
            <div className="border-t border-danger/30 bg-danger/5 px-4 py-2 text-xs text-danger">
              {queueError}
            </div>
          )}
        </div>
      )}

      {/* Empty state after search */}
      {!loading && results.length === 0 && source !== null && (
        <div className="panel flex flex-col items-center py-12 text-center">
          <Search className="size-10 text-muted-foreground/30" />
          <p className="mt-3 font-medium text-foreground">No results found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Try a different seed keyword
          </p>
        </div>
      )}
    </div>
  );
}

function DifficultyBadge({ value }: { value: number | null }) {
  if (value == null) return <span className="font-data text-muted-foreground">—</span>;

  let color = "text-signal";
  if (value >= 70) color = "text-danger";
  else if (value >= 40) color = "text-warning";

  return (
    <span className={`font-data font-medium ${color}`}>{value}</span>
  );
}
