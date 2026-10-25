export function ExternalExecutionNotice({
  executor,
  reviewOrigin,
  compact = false,
}: {
  executor: string | null;
  reviewOrigin: string | null;
  compact?: boolean;
}) {
  const label = executor === "helloada" ? "HelloAda" : executor ?? "the connected review workspace";
  return (
    <section className={compact ? "rounded-lg border border-border/60 bg-muted/10 p-4" : "panel p-5"}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={compact ? "font-heading text-sm font-semibold" : "font-heading text-lg font-semibold"}>
          Managed in {label}
        </h2>
        <span className="rounded-md bg-primary/10 px-2 py-1 font-data text-[10px] font-semibold uppercase text-primary">
          read only
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Owner approval, content preparation and publication for this site happen in {label}. CrawlSEO keeps
        the research evidence and Action history here for reference; changes made on this page would not
        reach the live site.
      </p>
      {reviewOrigin && (
        <a
          href={reviewOrigin}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition hover:border-primary/50"
        >
          Open {label} review
        </a>
      )}
    </section>
  );
}
