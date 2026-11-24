import type { CompetitorLeaderboard } from "@/lib/funnel/competitor-leaderboard";

/**
 * CMP-003: the leaderboard for one cluster.
 *
 * Each row is a measurement, not a claim: this domain ranked above us on this many
 * of the cluster's queries, at this average position, over this many samples. A
 * domain seen once appears once and the sample count says so.
 *
 * The declared-competitor mark is emphasis only. A domain a person never named is
 * still shown, because the point of the panel is what the SERP actually contains.
 */
export function CompetitorLeaderboardPanel({ board }: { board: CompetitorLeaderboard }) {
  if (board.competitors.length === 0) {
    return (
      <div className="panel px-4 py-4">
        <p className="text-sm text-muted-foreground">{board.reason}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          A competitor appears here only when a sampled SERP names it above our position. Nothing is guessed from a
          domain name.
        </p>
      </div>
    );
  }

  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <th className="px-4 py-2 font-medium">Domain</th>
              <th className="px-2 py-2 text-right font-medium">Queries</th>
              <th className="px-2 py-2 text-right font-medium">Avg</th>
              <th className="px-2 py-2 text-right font-medium">Best</th>
              <th className="px-2 py-2 text-right font-medium">1–3</th>
              <th className="px-2 py-2 text-right font-medium">4–10</th>
              <th className="px-2 py-2 text-right font-medium">11–20</th>
              <th className="px-4 py-2 font-medium">Holds where we do not rank</th>
            </tr>
          </thead>
          <tbody>
            {board.competitors.map((row) => (
              <tr key={row.domain} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2">
                  <span className="font-medium text-foreground">{row.domain}</span>
                  {row.declared && (
                    <span className="ml-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">declared</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right font-mono text-xs">{row.queries}</td>
                <td className="px-2 py-2 text-right font-mono text-xs">#{row.averagePosition}</td>
                <td className="px-2 py-2 text-right font-mono text-xs">#{row.bestPosition}</td>
                <td className="px-2 py-2 text-right font-mono text-xs text-muted-foreground">{row.at1to3 || "·"}</td>
                <td className="px-2 py-2 text-right font-mono text-xs text-muted-foreground">{row.at4to10 || "·"}</td>
                <td className="px-2 py-2 text-right font-mono text-xs text-muted-foreground">{row.at11to20 || "·"}</td>
                <td className="max-w-[22rem] px-4 py-2 text-[11px] text-muted-foreground">
                  {row.queriesWeDoNotRank.length === 0 ? (
                    <span className="text-muted-foreground/70">none — we rank for all of them</span>
                  ) : (
                    <span title={row.queriesWeDoNotRank.join(" · ")}>
                      {row.queriesWeDoNotRank.length} · {row.queriesWeDoNotRank.slice(0, 2).join(", ")}
                      {row.queriesWeDoNotRank.length > 2 ? ` +${row.queriesWeDoNotRank.length - 2}` : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        From {board.samples} sampled SERP {board.samples === 1 ? "snapshot" : "snapshots"}
        {board.queriesWithoutSample > 0
          ? ` · ${board.queriesWithoutSample} of this cluster's queries have no sample yet`
          : ""}
        . A domain seen once is shown with one query; the sample count is stated rather than hidden.
      </p>
    </div>
  );
}
