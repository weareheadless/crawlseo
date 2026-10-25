"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SEO_TIMEFRAMES, type SeoTimeframe } from "@/lib/seo-timeframes";

const LABELS: Record<SeoTimeframe, string> = {
  7: "Last 7 days",
  28: "Last 28 days",
  90: "Last 90 days",
  180: "Last 180 days",
};

export function TimeframeSelect({ value }: { value: SeoTimeframe }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function change(next: string) {
    const query = new URLSearchParams(params.toString());
    query.set("days", next);
    router.push(`${pathname}?${query.toString()}`);
  }

  return (
    <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground">
      <span className="sr-only">Timeframe</span>
      <select
        value={value}
        onChange={(event) => change(event.target.value)}
        className="bg-transparent text-xs font-medium text-foreground outline-none"
      >
        {SEO_TIMEFRAMES.map((days) => (
          <option key={days} value={days}>
            {LABELS[days]}
          </option>
        ))}
      </select>
    </label>
  );
}
