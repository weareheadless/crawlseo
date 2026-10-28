"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Site {
  id: string;
  domain: string;
}

const SECTION_SEGMENTS = new Set([
  "work",
  "content-studio",
  "opportunities",
  "keywords",
  "saved-keywords",
  "pages",
  "crawl",
  "vitals",
  "alerts",
  "intelligence",
  "business",
  "aeo-geo",
  "research",
  "keyword-research",
  "domain-overview",
  "backlinks",
  "mcp",
  "settings",
  "findings",
  "results",
]);

export function siteDestination(pathname: string, search: string, siteId: string) {
  const match = pathname.match(/\/sites\/[^/]+(?:\/([^/]+))?/);
  const legacy = match?.[1];
  const section = legacy === "content-studio" ? "work" : legacy === "opportunities" ? "findings" : legacy;
  const suffix = section && SECTION_SEGMENTS.has(section) ? `/${section}` : "";
  return `/sites/${siteId}${suffix}${search ? `?${search}` : ""}`;
}

export function SiteSwitcher({ sites }: { sites: Site[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();

  if (sites.length === 0) return null;

  const match = pathname.match(/\/sites\/([^/]+)/);
  const fromPath =
    match?.[1] && sites.some((s) => s.id === match[1]) ? match[1] : undefined;
  const selected = fromPath ?? sites[0].id;

  function handleSiteChange(siteId: string | null) {
    if (!siteId) return;

    router.push(siteDestination(pathname, query, siteId));
  }

  if (sites.length === 1) {
    return (
      <div className="rounded-lg border border-border/60 bg-panel/60 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {pathname.match(/\/sites\/[^/]+(?:\/([^/]+))?/)?.[1]?.replaceAll("-", " ") ?? "Overview"}
        </p>
        <p className="truncate text-sm font-medium text-foreground">
          {sites[0].domain}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-1.5 px-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {pathname.match(/\/sites\/[^/]+(?:\/([^/]+))?/)?.[1]?.replaceAll("-", " ") ?? "Overview"} · switch site
      </p>
      <Select value={selected} onValueChange={handleSiteChange}>
        <SelectTrigger className="w-full border-border/70 bg-panel">
          <SelectValue>
            {sites.find((site) => site.id === selected)?.domain ?? "Select a site"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {sites.map((site) => (
            <SelectItem key={site.id} value={site.id}>
              {site.domain}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
