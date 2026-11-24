import type { LinkTarget } from "@/lib/funnel/backlink-gap";

/**
 * CMP-007: the link-target list on a link-gap opportunity.
 *
 * The opportunity says "306 domains link to the pages above us without linking to
 * us". That sentence is only a brief if a person can read the list, so this panel
 * shows each target with the provider's own facts beside it: the domain's provider
 * rank, how many backlinks it has, and how many of the compared competitors it links
 * to.
 *
 * Three things it must not do:
 *  - **rank the targets by a judgement.** The order is provider rank, a number the
 *    provider reports. There is no "priority" score invented here.
 *  - **hide the shared domains.** A domain that already links to us is excluded from
 *    the targets, and the panel says how many were excluded — otherwise the gap looks
 *    bigger than it is.
 *  - **imply an automated campaign.** This is a list to work from. No email is sent,
 *    nothing is submitted anywhere.
 */

export type LinkTargetPanelProps = {
  targets: LinkTarget[];
  /** Domains that already link to us, excluded from the list. */
  sharedCount: number;
  /** How many competitors were measured, and which had no data. */
  competitorCount: number;
  missing: string[];
  /** Domains our own profile had, when it was measured. */
  ourDomainCount: number | null;
};

function rankLabel(rank: number | null): string {
  return rank != null && rank > 0 ? String(rank) : "—";
}

export function LinkTargetPanel({
  targets,
  sharedCount,
  competitorCount,
  missing,
  ourDomainCount,
}: LinkTargetPanelProps) {
  if (targets.length === 0) {
    return (
      <section className="panel mb-5 px-4 py-4" aria-label="Link targets">
        <h2 className="font-heading text-sm font-semibold">Link targets</h2>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {missing.length > 0
            ? `No referring-domain data for ${missing.join(", ")}, so the link gap is not measured.`
            : sharedCount > 0
              ? `No link gap: every domain linking to the ${competitorCount} compared competitor${competitorCount === 1 ? "" : "s"} also links to us.`
              : "No link targets were measured for this opportunity yet."}
        </p>
        {ourDomainCount != null && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {`Our own profile has ${ourDomainCount.toLocaleString()} referring domain${ourDomainCount === 1 ? "" : "s"}, so a shared domain is not offered as an opportunity.`}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="panel mb-5 overflow-hidden" aria-label="Link targets">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
        <h2 className="font-heading text-sm font-semibold">Link targets</h2>
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {`${targets.length.toLocaleString()} targets · ${competitorCount} competitor${competitorCount === 1 ? "" : "s"} compared`}
        </span>
      </div>
      <p className="mt-1 px-4 text-[11px] text-muted-foreground">
        These domains link to the pages ranking above us and not to us
        {sharedCount > 0
          ? `. ${sharedCount.toLocaleString()} domain${sharedCount === 1 ? "" : "s"} linking to both were excluded`
          : ""}
        . Ordered by the provider&apos;s domain rank.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <th className="px-4 py-2 font-medium">Domain</th>
              <th className="px-2 py-2 text-right font-medium">Rank</th>
              <th className="px-2 py-2 text-right font-medium">Links to</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((target) => (
              <tr key={target.domain} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-1.5">
                  <span className="font-mono text-xs text-foreground">{target.domain}</span>
                  {target.linkType === "nofollow" && (
                    <span className="ml-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">nofollow</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-xs">{rankLabel(target.rank)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                  {`${target.competitorsLinking} competitor${target.competitorsLinking === 1 ? "" : "s"}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        A measuring list, not a campaign: nothing here sends an email or submits anything. Every target points at a paid
        provider response that named it.
      </p>
    </section>
  );
}
