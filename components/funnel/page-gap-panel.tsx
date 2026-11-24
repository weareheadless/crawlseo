import type { PageGapResult } from "@/lib/funnel/page-gap";

/**
 * CMP-006: the gap brief on an opportunity.
 *
 * Shown below the plan, because it answers the question the plan raises: who is
 * winning this query, with what, and what do they have that we do not.
 *
 * Two things it must never do:
 *  - invent a deficit. When the comparison finds none, it says so — that is
 *    information, not an empty state.
 *  - hide an unreadable page. A competitor behind a WAF is recorded with its reason,
 *    so nobody assumes the page does not exist.
 */
export function PageGapPanel({ gap }: { gap: PageGapResult }) {
  const hasComparison = gap.readable.length > 0;

  return (
    <section className="panel mb-5 px-4 py-4" aria-label="Who is winning this query">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-sm font-semibold">Who is winning this query</h2>
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {gap.readable.length} compared
          {gap.unreadable.length > 0 ? ` · ${gap.unreadable.length} unreadable` : ""}
        </span>
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground">{gap.summary}</p>

      {hasComparison && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Page</th>
                <th className="px-2 py-1.5 text-right font-medium">Words</th>
                <th className="px-2 py-1.5 text-right font-medium">Headings</th>
                <th className="px-2 py-1.5 font-medium">Schema</th>
                <th className="px-2 py-1.5 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {gap.ours && (
                <tr className="border-b border-border/60 bg-[var(--a-neutral-100,#18181b)]">
                  <td className="py-1.5 pr-3">
                    <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">ours</span>
                    <div className="max-w-[26rem] truncate text-xs text-foreground" title={gap.ours.url}>
                      {gap.ours.url}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs">{gap.ours.wordCount?.toLocaleString() ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs">{gap.ours.headings.length}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">
                    {gap.ours.schemaTypes.length > 0 ? gap.ours.schemaTypes.join(", ") : gap.ours.hasSchema ? "present" : "none"}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                    {gap.ours.lastModified ? gap.ours.lastModified.toISOString().slice(0, 10) : "not recorded"}
                  </td>
                </tr>
              )}
              {gap.readable.map((page) => (
                <tr key={page.url} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-3">
                    {page.position != null && (
                      <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">#{page.position}</span>
                    )}
                    <span className="text-xs text-foreground">{page.domain ?? page.url}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs">{page.wordCount?.toLocaleString() ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs">{page.headings.length}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">
                    {page.schemaTypes.length > 0 ? page.schemaTypes.join(", ") : page.hasSchema ? "present" : "none"}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                    {page.lastModified ? page.lastModified.toISOString().slice(0, 10) : page.fetchedAt ? `read ${page.fetchedAt.toISOString().slice(0, 10)}` : "not recorded"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {gap.deficits.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">What they have that we do not</p>
          <ul className="mt-1 space-y-0.5">
            {gap.deficits.map((deficit) => (
              <li key={deficit.kind} className="text-[11px] text-foreground">
                · {deficit.sentence}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasComparison && gap.deficits.length === 0 && (
        <p className="mt-2 text-[11px] text-[var(--a-success-700,#34D399)]">
          No measurable deficit on words, headings or schema: this is not a content gap.
        </p>
      )}

      {gap.unreadable.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Could not be read</p>
          <ul className="mt-1 space-y-0.5">
            {gap.unreadable.map((row) => (
              <li key={row.url} className="truncate text-[11px] text-muted-foreground" title={`${row.url} — ${row.reason}`}>
                · {row.url} — {row.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {gap.pageStrengthReason && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Page strength is not used in this score: {gap.pageStrengthReason}.
        </p>
      )}
    </section>
  );
}
