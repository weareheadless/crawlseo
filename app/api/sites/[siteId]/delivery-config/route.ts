import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsSite } from "@/lib/auth/research-action-access";
import { saveSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { z } from "zod";
import { ZodError } from "zod";

const schema = z.object({
  bridgeAlias: z.string().trim().min(1).max(120),
  adapters: z.array(z.enum(["wix_embed", "wix_blog", "manual"])).min(1).max(3),
  enabled: z.boolean().default(true),
});

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  try {
    const input = schema.parse(await req.json());
    const config = await saveSiteDeliveryConfig(siteId, input);
    return Response.json({ config });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid delivery configuration" }, { status: 400 });
    }
    console.error("Delivery config save error:", error);
    return Response.json({ error: "Could not save the delivery configuration" }, { status: 500 });
  }
}
