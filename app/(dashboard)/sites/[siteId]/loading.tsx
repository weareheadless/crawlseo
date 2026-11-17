/**
 * Site-scoped loading boundary.
 *
 * The site pages do the most work in the product (crawl issues, evidence,
 * opportunity rows), and all of them are dynamic. This boundary paints the page
 * chrome as soon as the click lands, so navigation never looks dead while the
 * server queries run.
 */
export default function SiteLoading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-3">
        <div className="h-3 w-32 rounded bg-muted/60" />
        <div className="h-7 w-72 rounded bg-muted/60" />
        <div className="h-3 w-96 max-w-full rounded bg-muted/40" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="panel h-16" />
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-8 w-24 rounded-lg bg-muted/40" />
        ))}
      </div>

      <div className="panel h-80" />
      <div className="panel h-64" />
    </div>
  );
}
