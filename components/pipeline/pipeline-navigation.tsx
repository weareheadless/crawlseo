import Link from "next/link";
import { PIPELINE_STAGES, buildStageUrl, type PipelineStageId } from "@/lib/pipeline/stages";

export function PipelineNavigation({ siteId, currentStage }: { siteId: string; currentStage: PipelineStageId }) {
  return (
    <nav aria-label="Site pipeline" className="panel p-3">
      <ol className="flex flex-wrap gap-2" aria-label="Pipeline stages">
        {PIPELINE_STAGES.map((stage, index) => {
          const current = stage.id === currentStage;
          return <li key={stage.id} className="flex items-center gap-2">
            {index > 0 && <span aria-hidden="true" className="text-muted-foreground">›</span>}
            <Link href={buildStageUrl(siteId, stage.id)} aria-current={current ? "step" : undefined}
              className={`rounded-md px-3 py-2 font-heading text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${current ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted"}`}>
              {stage.label}
            </Link>
          </li>;
        })}
      </ol>
    </nav>
  );
}

export function PipelineStageContext({ siteId, currentStage }: { siteId: string; currentStage: PipelineStageId }) {
  const index = PIPELINE_STAGES.findIndex((stage) => stage.id === currentStage);
  const stage = PIPELINE_STAGES[index];
  const previous = PIPELINE_STAGES[index - 1];
  const next = PIPELINE_STAGES[index + 1];
  return <section aria-label={`${stage.label} stage context`} className="panel grid gap-3 p-4 sm:grid-cols-3">
    <div><p className="font-data text-xs uppercase text-muted-foreground">Upstream input</p><p className="mt-1 text-sm">{stage.inputs}</p>
      {previous && <Link className="mt-2 inline-block text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={buildStageUrl(siteId, previous.id)}>← {previous.label}</Link>}</div>
    <div><p className="font-data text-xs uppercase text-muted-foreground">Downstream output</p><p className="mt-1 text-sm">{stage.outputs}</p>
      {next && <Link className="mt-2 inline-block text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={buildStageUrl(siteId, next.id)}>{next.label} →</Link>}</div>
    <div><p className="font-data text-xs uppercase text-muted-foreground">Next step</p><p className="mt-1 text-sm">{next ? `Review ${next.label} when its inputs are available.` : "Review recorded outcomes and decide what to do next."}</p></div>
  </section>;
}
