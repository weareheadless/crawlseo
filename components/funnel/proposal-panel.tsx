import { laneLabel, type OpportunityProposal } from "@/lib/funnel/proposal";

/**
 * The Phase 3 proposal, stated before the evidence.
 *
 * The old decision summary can show the change and the success measure from the
 * score inputs, but it cannot show the lane, the why-now, the expiry or the
 * critique because those live in the proposal contract. This panel is the
 * board's promise: the human sees exactly what would become a task.
 */
export function ProposalPanel({ proposal }: { proposal: OpportunityProposal | null }) {
  if (!proposal) return null;
  return (
    <div className="panel mb-6 space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Proposal</span>
        <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-foreground">
          {laneLabel(proposal.lane)}
        </span>
        <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-foreground">
          {proposal.kind}
        </span>
        <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-foreground">
          effort · {proposal.effort}
        </span>
        <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-foreground">
          confidence · {proposal.confidence ?? "not assessed"}
        </span>
        {proposal.expiresAt && (
          <span className="rounded-full border border-[var(--a-warning-300)] bg-[var(--a-warning-50)] px-2 py-0.5 text-[11px] text-[var(--a-warning-800)]">
            expires {proposal.expiresAt.slice(0, 10)}
          </span>
        )}
      </div>

      {proposal.whyNow && (
        <p className="text-xs text-foreground/85">
          <span className="text-muted-foreground">Why now: </span>
          {proposal.whyNow}
        </p>
      )}

      {proposal.confidenceReason && (
        <p className="text-xs text-foreground/85">
          <span className="text-muted-foreground">Confidence: </span>
          {proposal.confidenceReason}
        </p>
      )}
      <p className="text-xs text-foreground/85">
        <span className="text-muted-foreground">Target: </span>
        {proposal.target.url ? (
          <a
            href={proposal.target.url}
            target="_blank"
            rel="noreferrer"
            className="break-all text-primary underline decoration-primary/60 underline-offset-2"
          >
            {proposal.target.url}
          </a>
        ) : proposal.target.newAsset ? (
          "new asset"
        ) : (
          "no page"
        )}
        {proposal.target.section ? ` · ${proposal.target.section}` : ""}
      </p>
      <p className="text-xs text-foreground/85">
        <span className="text-muted-foreground">Action: </span>
        {proposal.action}
      </p>
      <p className="text-xs text-foreground/85">
        <span className="text-muted-foreground">Expected outcome: </span>
        {proposal.expectedOutcome}
      </p>
      {proposal.sources.length > 0 && (
        <p className="text-xs text-foreground/85">
          <span className="text-muted-foreground">Sources: </span>
          {proposal.sources.map((source, index) => (
            <span key={source.url}>
              {index > 0 ? " · " : ""}
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-primary underline decoration-primary/60 underline-offset-2"
              >
                {source.title || source.url}
              </a>
            </span>
          ))}
        </p>
      )}
      {proposal.critique && (
        <p className="text-xs text-foreground/85">
          <span className="text-muted-foreground">Critique: </span>
          {proposal.critique.verdict} — {proposal.critique.reason}
        </p>
      )}
    </div>
  );
}
