/**
 * Remove tenants created for deployment previews.
 *
 *   npx tsx scripts/cleanup-preview-tenants.ts              # report only
 *   npx tsx scripts/cleanup-preview-tenants.ts --apply      # delete rows
 *   npx tsx scripts/cleanup-preview-tenants.ts --apply --google
 *
 * Helloada provisions a project for every build, including the preview host
 * (`<name>.<preview domain>`). Each preview got a project, a site, a crawl and
 * a verified Search Console property, so the property list grew with every
 * deploy. Provisioning now refuses preview hosts (see lib/projects/
 * provision-project.ts); this script clears what the old behaviour left behind.
 *
 * Guards, so a wrong run cannot touch a real tenant:
 *  - a project is deleted only when every site in it is a preview host;
 *  - a preview site inside a real project is deleted alone, never its project;
 *  - in-flight jobs are cancelled first;
 *  - Google properties are only touched with --google, and only for the
 *    preview domains being removed.
 */
import { PrismaClient } from "@prisma/client";

import { isPreviewHost } from "@/lib/projects/provision-project";

type Target =
  | { kind: "project"; projectId: string; name: string; domains: string[] }
  | { kind: "site"; siteId: string; projectId: string; projectName: string; domain: string };

async function listTargets(db: PrismaClient): Promise<Target[]> {
  const projects = await db.project.findMany({
    select: {
      id: true,
      name: true,
      sites: { select: { id: true, domain: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const targets: Target[] = [];
  for (const project of projects) {
    if (project.sites.length === 0) continue;
    const previews = project.sites.filter((site) => isPreviewHost(site.domain));
    if (previews.length === 0) continue;
    if (previews.length === project.sites.length) {
      targets.push({
        kind: "project",
        projectId: project.id,
        name: project.name,
        domains: previews.map((site) => site.domain),
      });
    } else {
      for (const site of previews) {
        targets.push({
          kind: "site",
          siteId: site.id,
          projectId: project.id,
          projectName: project.name,
          domain: site.domain,
        });
      }
    }
  }
  return targets;
}

async function cancelJobs(db: PrismaClient, where: { siteId?: string; projectId?: string }): Promise<number> {
  const result = await db.job.updateMany({
    where: { ...where, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "CANCELLED", lastErrorCode: "PREVIEW_CLEANUP" },
  });
  return result.count;
}

/**
 * Deletes the Search Console entry and the verification record for a preview
 * host, using the platform service-account connection that owns it. The grant
 * rows are gone by the time this runs, so the connection itself is the source
 * of credentials.
 */
async function serviceAccountToken(): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const { decryptCredential } = await import("@/lib/encryption");
  const { ServiceAccountCredentialProvider } = await import("@/lib/integrations/google/credential-provider");
  const connection = await db.googleConnection.findFirst({
    where: { type: "SERVICE_ACCOUNT", status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { encryptedCredentials: true },
  });
  if (!connection) return null;
  const credentials = JSON.parse(decryptCredential(connection.encryptedCredentials)) as Record<string, unknown>;
  const provider = new ServiceAccountCredentialProvider(credentials);
  return provider.getAccessToken([
    "https://www.googleapis.com/auth/webmasters",
    "https://www.googleapis.com/auth/siteverification",
  ]).catch(() => null);
}

async function listPreviewProperties(token: string): Promise<string[]> {
  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { siteEntry?: Array<{ siteUrl: string }> };
  return (body.siteEntry ?? [])
    .map((entry) => entry.siteUrl)
    .filter((siteUrl) => {
      const host = siteUrl.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return isPreviewHost(host);
    });
}

async function deleteGoogleProperty(token: string, siteUrl: string): Promise<string> {

  const searchConsole = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const verificationList = await fetch("https://www.googleapis.com/siteVerification/v1/webResource", {
    headers: { Authorization: `Bearer ${token}` },
  });
  let verification = "verification list unavailable";
  if (verificationList.ok) {
    const body = (await verificationList.json()) as { items?: Array<{ id: string; site?: { identifier?: string } }> };
    const match = body.items?.find((item) => item.site?.identifier === siteUrl);
    if (!match) verification = "no verification record";
    else {
      const removed = await fetch(
        // The id is returned already percent-encoded; encoding it again is a 400.
        `https://www.googleapis.com/siteVerification/v1/webResource/${match.id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
      );
      verification = removed.ok ? "verification removed" : `verification delete ${removed.status}`;
    }
  }
  return `search console ${searchConsole.status === 204 ? "removed" : searchConsole.status}; ${verification}`;
}

async function main(): Promise<void> {
  const db = new PrismaClient();
  const apply = process.argv.includes("--apply");
  const google = process.argv.includes("--google");
  if (process.argv.includes("--google-only")) {
    const token = await serviceAccountToken();
    if (!token) {
      process.stdout.write("no service-account token available\n");
      await db.$disconnect();
      return;
    }
    const properties = await listPreviewProperties(token);
    if (properties.length === 0) process.stdout.write("no preview properties in Search Console\n");
    for (const property of properties) {
      process.stdout.write(`${property}\n  ${await deleteGoogleProperty(token, property)}\n`);
    }
    // Verification records outlive the Search Console entry, so they get their
    // own sweep. Only preview hosts are touched.
    const verificationList = await fetch("https://www.googleapis.com/siteVerification/v1/webResource", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (verificationList.ok) {
      const body = (await verificationList.json()) as {
        items?: Array<{ id: string; site?: { identifier?: string } }>;
      };
      for (const item of body.items ?? []) {
        const identifier = item.site?.identifier ?? "";
        const host = identifier.replace(/^sc-domain:/, "").replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
        if (!host || !isPreviewHost(host)) continue;
        const removed = await fetch(
          `https://www.googleapis.com/siteVerification/v1/webResource/${item.id}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
        );
        process.stdout.write(`verification ${identifier}: ${removed.status === 204 ? "removed" : removed.status}\n`);
      }
    }
    await db.$disconnect();
    return;
  }

  const targets = await listTargets(db);

  if (targets.length === 0) {
    process.stdout.write("no preview tenants found\n");
    await db.$disconnect();
    return;
  }

  for (const target of targets) {
    if (target.kind === "project") {
      const [crawls, evidence, opportunities, jobs] = await Promise.all([
        db.crawl.count({ where: { site: { projectId: target.projectId } } }),
        db.evidenceRecord.count({ where: { projectId: target.projectId } }),
        db.opportunity.count({ where: { projectId: target.projectId } }),
        db.job.count({ where: { projectId: target.projectId } }),
      ]);
      process.stdout.write(
        `project ${target.name} (${target.projectId})\n  previews: ${target.domains.join(", ")}\n  crawls=${crawls} evidence=${evidence} opportunities=${opportunities} jobs=${jobs}\n`
      );
      if (!apply) continue;
      await cancelJobs(db, { projectId: target.projectId });
      await db.project.delete({ where: { id: target.projectId } });
      process.stdout.write(`  deleted project\n`);
      if (google) {
        const token = await serviceAccountToken();
        for (const domain of target.domains) {
          const siteUrl = `https://${domain}/`;
          process.stdout.write(
            `  google ${domain}: ${token ? await deleteGoogleProperty(token, siteUrl) : "no service-account token"}\n`
          );
        }
      }
    } else {
      const [crawls, evidence, jobs] = await Promise.all([
        db.crawl.count({ where: { siteId: target.siteId } }),
        db.evidenceRecord.count({ where: { siteId: target.siteId } }),
        db.job.count({ where: { siteId: target.siteId } }),
      ]);
      process.stdout.write(
        `site ${target.domain} in project ${target.projectName} (${target.projectId})\n  crawls=${crawls} evidence=${evidence} jobs=${jobs}\n`
      );
      if (!apply) continue;
      await cancelJobs(db, { siteId: target.siteId });
      await db.site.delete({ where: { id: target.siteId } });
      process.stdout.write(`  deleted site\n`);
      if (google) {
        const token = await serviceAccountToken();
        process.stdout.write(
          `  google ${target.domain}: ${token ? await deleteGoogleProperty(token, `https://${target.domain}/`) : "no service-account token"}\n`
        );
      }
    }
  }

  if (!apply) process.stdout.write("\nreport only: pass --apply to delete, --google to remove the properties\n");
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "cleanup failed");
  process.exitCode = 1;
});
