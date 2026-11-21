import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { canAccessSite } from "@/lib/site/access";

/**
 * The access guard every dashboard action and page uses.
 *
 * One definition, so a new action cannot ship with a weaker check than the page
 * that links to it. It redirects rather than returning a partial: an unauthorised
 * caller never reaches the work.
 */
export async function requireSiteAccess(siteId: string) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, projectId: true } });
  if (!site || !site.projectId || !canAccessSite(userId, site)) redirect("/sites");
  return { ...site, projectId: site.projectId, userId };
}
