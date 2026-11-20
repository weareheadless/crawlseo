/**
 * One answer to "may this account open this site?".
 *
 * Access is workspace-wide: a deployment serves one operator workspace, so any
 * signed-in account may open any site in it. The dashboard already lists every
 * site and the project-provisioned sites carry no `userId` at all, so comparing
 * the row owner sent a signed-in operator back to the site list from Settings
 * and Work the moment the site had been created under another account.
 *
 * The session is the boundary: no user, no site. A per-user boundary belongs to
 * a workspace model, not to a site row.
 */
export type SiteAccessRecord = { userId: string | null };

export function canAccessSite(userId: string, _site: SiteAccessRecord): boolean {
  // The row is passed because every caller already loaded it; access no longer
  // depends on its owner.
  void _site;
  return Boolean(userId?.trim());
}
