import { IntegrationProvider } from "@prisma/client";

import { db } from "@/lib/db";
import { getProjectGoogleProvider } from "@/lib/integrations/google/connections";

async function main() {
  const [externalProjectId] = process.argv.slice(2);
  const project = await db.project.findFirst({ where: { externalProjectId } });
  if (!project) throw new Error("project not found");
  const site = await db.site.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, gscProperty: true } });
  if (!site) throw new Error("site not found");
  const { provider } = await getProjectGoogleProvider(project.id, IntegrationProvider.GOOGLE_SEARCH_CONSOLE, { siteId: site.id });
  const token = await provider.getAccessToken(["https://www.googleapis.com/auth/webmasters.readonly"]);
  const response = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.gscProperty ?? "")}/searchAnalytics/query`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: "2026-08-29", endDate: "2026-09-27", dimensions: ["query"], rowLimit: 5 }) },
  );
  console.log("status:", response.status);
  console.log((await response.text()).slice(0, 400));
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exitCode = 1; });
