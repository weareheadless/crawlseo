import Link from "next/link";
import type { readPipelineResults } from "@/lib/pipeline/results";

type Results = Awaited<ReturnType<typeof readPipelineResults>>;
const labels = {
  not_delivered: "No delivery receipt recorded",
  delivered_unverified: "Delivered · verification not recorded",
  verification_recorded: "Verification timestamp recorded · result unknown",
  verified_unmeasured: "Verified · no measured outcome linked",
  measured_unattributed: "Measurement recorded · causal impact not established",
} as const;

export function ResultsPanel({ siteId, results }: { siteId: string; results: Results }) {
  return <div className="space-y-6">
    <section className="panel p-4 sm:p-5">
      <h2 className="font-heading text-lg font-semibold">What changed</h2>
      <p className="mt-1 text-sm text-muted-foreground">Delivery, recorded verification, measurement and causal impact are separate evidence. Window: last {results.windowDays} days.</p>
      {results.actions.length ? <div className="mt-3 divide-y divide-border/50">{results.actions.map((item) => <article key={item.actionId} className="py-3">
        <Link className="font-medium text-primary underline underline-offset-2" href={`/sites/${siteId}/actions/${item.actionId}`}>{item.title}</Link>
        <p className="mt-1 text-sm">{labels[item.result]}{item.deliveryStatus ? ` · receipt ${item.deliveryStatus.toLowerCase()}` : ""}</p>
        <p className="mt-1 text-xs text-muted-foreground">Updated {item.updatedAt.toLocaleDateString()}{item.deliveredAt ? ` · delivered ${item.deliveredAt.toLocaleDateString()}` : ""}{item.verifiedAt ? ` · verification timestamp ${item.verifiedAt.toLocaleDateString()}` : ""}{item.measuredAt ? ` · measured ${item.measuredAt.toLocaleDateString()}` : ""}</p>
      </article>)}</div> : <p className="mt-3 text-sm text-muted-foreground">No action delivery evidence in this 90-day window. This is not evidence that no changes occurred.</p>}
      {results.hasMoreActions && <p className="mt-2 text-xs text-muted-foreground">Showing first 50 recent actions; list is truncated.</p>}
    </section>
    <section className="panel p-4 sm:p-5">
      <h2 className="font-heading text-lg font-semibold">Search and AI observations</h2>
      <p className="mt-1 text-sm text-muted-foreground">Imported observations describe measurements only; they are not attributed to an action. Window: last {results.windowDays} days.</p>
      {results.observations.length ? <ul className="mt-3 divide-y divide-border/50">{results.observations.map((o, i) => <li key={`${o.provider}-${o.modelSurface}-${o.observedAt.toISOString()}-${i}`} className="py-2 text-sm">{o.provider} · {o.modelSurface} · observed {o.observedAt.toLocaleDateString()}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">No customer observations imported for this period. No baseline or visibility result is available.</p>}
      {results.fixtureObservations > 0 && <p className="mt-2 text-xs text-muted-foreground">{results.fixtureObservations} fixture-only observation(s) excluded from customer totals.</p>}
      {results.hasMoreObservations && <p className="mt-2 text-xs text-muted-foreground">Observation list is truncated to 100.</p>}
    </section>
  </div>;
}
