/**
 * Route-level loading boundary.
 *
 * Every dashboard page is rendered per request against Postgres. Without a
 * loading.tsx the browser keeps the previous screen until the server finishes,
 * so a slow query reads as a frozen tab. This renders the shell skeleton
 * immediately and also lets the router prefetch only this boundary instead of
 * the whole dynamic page.
 */
export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-3">
        <div className="h-3 w-24 rounded bg-muted/60" />
        <div className="h-7 w-64 rounded bg-muted/60" />
        <div className="h-3 w-80 rounded bg-muted/40" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="panel p-4">
            <div className="h-3 w-24 rounded bg-muted/50" />
            <div className="mt-3 h-7 w-20 rounded bg-muted/60" />
            <div className="mt-2 h-3 w-32 rounded bg-muted/40" />
          </div>
        ))}
      </div>
      <div className="panel h-64" />
      <div className="panel h-72" />
    </div>
  );
}
