import { ExternalLink, FileSearch, Link2, ShieldCheck } from "lucide-react";
import {
  isSafeHttpUrl,
  selectEvidenceSources,
  sourceHost,
  sourceProviderLabel,
  sourcePublisher,
  type ResearchEvidenceSource,
} from "@/lib/research/evidence";

function dateLabel(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function sourceTitle(source: ResearchEvidenceSource): string {
  return source.title?.trim() || sourceHost(source.url);
}

export function SourceList({
  sources,
  title = "Sources",
  description,
  emptyText = "No source links were stored for this item.",
}: {
  sources: ResearchEvidenceSource[];
  title?: string;
  description?: string;
  emptyText?: string;
}) {
  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-signal" />
            <h2 className="font-heading text-lg font-semibold">{title}</h2>
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-data text-[10px] text-muted-foreground">
              {sources.length}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            {description ?? "Open each link to verify the original source. The excerpt below is the text stored when the source was retrieved, not a model paraphrase."}
          </p>
        </div>
      </div>

      {sources.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <ol className="mt-4 space-y-2">
          {sources.map((source, index) => (
            <SourceCard key={source.id} source={source} index={index} />
          ))}
        </ol>
      )}
    </section>
  );
}

function SourceCard({ source, index }: { source: ResearchEvidenceSource; index: number }) {
  const publisher = sourcePublisher(source);
  const published = dateLabel(source.publishedAt);
  const retrieved = dateLabel(source.retrievedAt);
  const safe = isSafeHttpUrl(source.url);
  const title = sourceTitle(source);

  return (
    <li className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-data text-[10px] text-muted-foreground">
            <span className="rounded bg-background px-1.5 py-0.5">{index + 1}</span>
            <span className="rounded bg-background px-1.5 py-0.5">{sourceProviderLabel(source.provider)}</span>
            {publisher && <span className="rounded bg-background px-1.5 py-0.5">{publisher}</span>}
            {published && <span>Published {published}</span>}
            {source.author && <span>by {source.author}</span>}
          </div>

          <div className="mt-1.5 flex items-start gap-1.5">
            {safe ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="break-words text-sm font-medium text-foreground underline decoration-border underline-offset-2 hover:text-primary"
              >
                {title}
              </a>
            ) : (
              <span className="break-words text-sm font-medium">{title}</span>
            )}
            {safe && <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          </div>

          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {source.excerpt?.trim() || "No stored excerpt. Open the original to inspect the source."}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 font-data text-[10px] text-muted-foreground/70">
            <span className="break-all">
              {sourceHost(source.url)}
              {retrieved ? ` · retrieved ${retrieved}` : ""}
            </span>
            {safe && (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
              >
                Open original <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function SourceCitations({
  sources,
  sourceIds,
  emptyText = "No linked sources.",
}: {
  sources: ResearchEvidenceSource[];
  sourceIds: string[];
  emptyText?: string;
}) {
  const selected = selectEvidenceSources(sources, sourceIds);
  if (selected.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {selected.map((source) => {
        const title = sourceTitle(source);
        return isSafeHttpUrl(source.url) ? (
          <a
            key={source.id}
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
            title={title}
          >
            <Link2 className="size-3 shrink-0" />
            <span className="truncate">{title}</span>
          </a>
        ) : (
          <span key={source.id} className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
            <FileSearch className="size-3" /> {title}
          </span>
        );
      })}
    </div>
  );
}
