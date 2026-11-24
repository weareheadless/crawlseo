import type { ClusterScoreboard } from "@/lib/funnel/share-of-voice";

/**
 * CMP-008: the cluster scoreboard.
 *
 * One number per cluster that a client understands, measured from the samples we hold:
 * our share of voice against each named competitor, and the list of queries we lose and
 * to whom.
 *
 * Three rules the panel exists to keep:
 *  - **Every number is traceable.** Each line says how many queries it rests on, and the
 *    footer says when the sample was taken. Nothing here is an estimate.
 *  - **`unobserved` is not 0%.** A cluster with no sample shows the word, no percentage,
 *    and no bar. Reporting zero would say "we are invisible" when nobody looked.
 *  - **The curve is a model.** The share is modelled from a declared position→CTR
 *    curve, not from observed clicks, and the panel says so in its own words.
 */
export function ShareOfVoicePanel({ board }: { board: ClusterScoreboard }) {
  const latest = board.latest;

  if (board.unobserved || !latest || latest.unobserved) {
    return (
      <section className="panel mb-5 px-4 py-4" aria-label="Share of voice">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-heading text-sm font-semibold">Share of voice</h2>
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">unobserved</span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {`No SERP sample has been taken for this cluster, so its share of voice is unknown. This is not a zero share: nobody has looked yet.`}
        </p>
      </section>
    );
  }

  const statusLabel: Record<string, string> = {
    winning: "winning",
    contending: "contending",
    losing: "losing",
    unobserved: "unobserved",
  };

  return (
    <section className="panel mb-5 overflow-hidden" aria-label="Share of voice">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
        <h2 className="font-heading text-sm font-semibold">Share of voice</h2>
        <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          <span
            className={
              board.status.status === "winning"
                ? "text-[var(--a-success-700,#34D399)]"
                : board.status.status === "losing"
                  ? "text-[var(--a-warning-700)]"
                  : "text-muted-foreground"
            }
          >
            {statusLabel[board.status.status] ?? board.status.status}
          </span>
          {latest.week && <span>{`· week of ${latest.week}`}</span>}
        </span>
      </div>

      <p className="mt-1 px-4 text-[11px] text-muted-foreground">{board.status.reason}</p>

      <div className="mt-3 space-y-1.5 px-4">
        {latest.domains.map((row) => (
          <div key={row.domain} className="flex items-center gap-2">
            <span
              className={`w-[13rem] shrink-0 truncate font-mono text-[11px] ${row.us ? "text-foreground" : "text-muted-foreground"}`}
              title={row.domain}
            >
              {row.domain}
              {row.us ? " (us)" : ""}
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-sm bg-[var(--a-neutral-200,#27272a)]">
              <span
                className="block h-full rounded-sm"
                style={{
                  width: `${Math.max(1, Math.round(row.share * 100))}%`,
                  background: row.us ? "var(--primary)" : "var(--chart-2, #71717a)",
                }}
              />
            </span>
            <span className="w-10 shrink-0 text-right font-mono text-[11px]">{`${(row.share * 100).toFixed(0)}%`}</span>
            <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
              {`${row.queries} ${row.queries === 1 ? "query" : "queries"}`}
            </span>
          </div>
        ))}
      </div>

      {board.losing.length > 0 && (
        <div className="mt-3 border-t border-border px-4 py-2">
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Queries we do not hold</p>
          <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
            {board.losing.slice(0, 8).map((row) => (
              <li key={row.query} className="truncate text-[11px] text-muted-foreground" title={`${row.query} — ${row.domain} #${row.position}`}>
                {`· “${row.query}” — `}
                <span className="font-mono text-foreground">{row.domain}</span>
                {` #${row.position}`}
              </li>
            ))}
          </ul>
          {board.losing.length > 8 && (
            <p className="mt-1 text-[10px] text-muted-foreground">{`and ${board.losing.length - 8} more`}</p>
          )}
        </div>
      )}

      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        {`${latest.queriesObserved} ${latest.queriesObserved === 1 ? "query" : "queries"} observed · ${latest.domains.length} ${latest.domains.length === 1 ? "domain" : "domains"} attributed · share modelled from a declared position→CTR curve, not observed clicks.`}
      </p>
    </section>
  );
}
