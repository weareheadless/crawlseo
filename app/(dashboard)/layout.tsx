import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { getSupersededSiteIds } from "@/lib/research/execution-authority";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const userId = await getUserIdFromCookies();

  if (!userId) {
    redirect("/login");
  }

  // Fetch user info for the shell
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, image: true },
  });

  // Single-operator CrawlSEO: authenticated users see every site,
  // including project-provisioned sites with no userId.
  const [allSites, superseded] = await Promise.all([
    db.site.findMany({
      select: { id: true, domain: true },
      orderBy: { domain: "asc" },
    }),
    getSupersededSiteIds(),
  ]);
  const sites = allSites.filter((site) => !superseded.has(site.id));

  return (
    <AppShell
      email={user?.email ?? undefined}
      name={user?.name ?? undefined}
      image={user?.image ?? undefined}
      sites={sites}
    >
      {children}
    </AppShell>
  );
}
