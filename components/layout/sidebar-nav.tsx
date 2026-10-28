"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Building2, Microscope, Lightbulb, ListChecks, ChartNoAxesCombined, Settings, Globe, type LucideIcon } from "lucide-react";

export type PipelineNavItem = { href: string; label: string; icon: LucideIcon; exact?: boolean };
export type PipelineNavGroup = { label: string; items: PipelineNavItem[] };

export function buildSidebarGroups(siteId?: string): PipelineNavGroup[] {
  const groups: PipelineNavGroup[] = [{ label: "Overview", items: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/sites", label: "Sites", icon: Globe, exact: true },
    ...(siteId ? [{ href: `/sites/${siteId}`, label: "Site overview", icon: LayoutDashboard, exact: true }] : []),
  ] }];
  if (!siteId) return groups;
  return [...groups,
    { label: "Business", items: [{ href: `/sites/${siteId}/business`, label: "Business", icon: Building2 }] },
    { label: "Research", items: [{ href: `/sites/${siteId}/research`, label: "Research", icon: Microscope }] },
    { label: "Findings", items: [{ href: `/sites/${siteId}/findings`, label: "Findings", icon: Lightbulb }] },
    { label: "Work", items: [{ href: `/sites/${siteId}/work`, label: "Work", icon: ListChecks }] },
    { label: "Results", items: [{ href: `/sites/${siteId}/results`, label: "Results", icon: ChartNoAxesCombined }] },
    { label: "Settings", items: [{ href: `/sites/${siteId}/settings`, label: "Settings", icon: Settings }] },
  ];
}

export function SidebarNav({ sites, collapsed = false }: { sites: { id: string; domain: string }[]; collapsed?: boolean }) {
  const pathname = usePathname();
  const match = pathname.match(/\/sites\/([^/]+)/);
  const siteId = match?.[1] && sites.some((s) => s.id === match[1]) ? match[1] : undefined;
  const groups = buildSidebarGroups(siteId);
  return <nav aria-label="Primary" className="flex-1 space-y-4 overflow-y-auto px-2 text-sm">
    {groups.map((group) => <section key={group.label} aria-label={group.label}>
      {!collapsed && <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{group.label}</p>}
      <div className="space-y-0.5">{group.items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} title={collapsed ? item.label : undefined} className={cn("flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary", active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/75 hover:bg-muted hover:text-foreground", collapsed && "size-10 justify-center px-0")}><Icon aria-hidden="true" className="size-4 shrink-0" />{!collapsed && item.label}</Link>;
      })}</div>
    </section>)}
  </nav>;
}
