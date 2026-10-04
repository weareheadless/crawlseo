import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";

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

  const sites = await db.site.findMany({
    where: { userId },
    select: { id: true, domain: true },
    orderBy: { domain: "asc" },
  });

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
