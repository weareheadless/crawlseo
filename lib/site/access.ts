/**
 * One answer to "may this account open this site?".
 *
 * A site created by manual login carries `userId`; a site provisioned into a
 * project does not. The project-provisioned site is reached through the
 * authenticated workspace, which is the same boundary every funnel surface
 * (demand, opportunities, evidence) already uses. Settings and Work used to
 * compare `site.userId === userId` directly, which made every project-owned
 * site unreachable and sent the reader back to the site list.
 */
export type SiteAccessRecord = { userId: string | null };

export function canAccessSite(userId: string, site: SiteAccessRecord): boolean {
  if (!userId) return false;
  return site.userId === null || site.userId === userId;
}
