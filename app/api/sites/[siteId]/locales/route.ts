import { z } from "zod";
import { ZodError } from "zod";

import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsSite } from "@/lib/auth/research-action-access";
import { getSiteLocales, parseSiteLocales, saveSiteLocales } from "@/lib/site-locales";

const schema = z.object({
  default: z.string().trim().min(2).max(10),
  variants: z.array(z.object({
    code: z.string().trim().min(2).max(10),
    prefix: z.string().trim().max(10).optional(),
    query: z.string().trim().max(80).nullable().optional(),
  })).min(1).max(12),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  return Response.json({ locales: await getSiteLocales(siteId) });
}

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
    const parsed = parseSiteLocales({
      default: input.default,
      variants: input.variants.map((variant) => ({
        code: variant.code,
        prefix: variant.prefix ?? "",
        query: variant.query ?? null,
      })),
    });
    if (!parsed) {
      return Response.json({ error: "Each locale needs a two-letter code, and a prefix or query must be valid" }, { status: 400 });
    }
    return Response.json({ locales: await saveSiteLocales(siteId, parsed) });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid locale list" }, { status: 400 });
    }
    console.error("Locale save error:", error);
    return Response.json({ error: "Could not save the locale list" }, { status: 500 });
  }
}
