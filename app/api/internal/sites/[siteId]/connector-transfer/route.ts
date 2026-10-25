import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { bindingTransferSchema } from "@/lib/connectors/types";
import { ConnectorError, transferConnectorBinding } from "@/lib/connectors/service";
import { db } from "@/lib/db";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";

function authorized(req: Request): boolean {
  const configured = process.env.HELLOADA_PROVISIONING_TOKEN;
  const header = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !header) return false;
  return timingSafeEqual(createHash("sha256").update(configured).digest(), createHash("sha256").update(header).digest());
}

export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { siteId } = await params;
    const input = bindingTransferSchema.parse({ ...(await req.json()), siteId });
    const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } });
    if (!site) return Response.json({ error: "Project site not found" }, { status: 404 });
    const result = await transferConnectorBinding({ projectId: site.projectId } as ServicePrincipalContext, input);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid transfer" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector transfer failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
