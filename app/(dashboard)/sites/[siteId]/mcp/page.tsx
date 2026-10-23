import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { McpPageContent } from "@/components/mcp/mcp-page-content";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function McpPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site) redirect("/sites");

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="AI & MCP"
        description="Connect your AI agent to CrawlSEO via the Model Context Protocol"
      />
      <McpPageContent />
    </div>
  );
}
