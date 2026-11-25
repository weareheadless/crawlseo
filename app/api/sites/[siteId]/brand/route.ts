import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsSite } from "@/lib/auth/research-action-access";
import { db } from "@/lib/db";
import { COLOR_NAME, emptyRepresentation, readSiteBrand, saveSiteBrand } from "@/lib/site/brand";
import { ZodError, z } from "zod";

/**
 * The brand block a render reads.
 *
 * This is the only writer. `saveSiteBrand` existed without a caller, so the
 * persona that the cover is designed from could only be set by editing the
 * database by hand — which is why the design brief had nothing in it.
 *
 * Representation is deliberately not edited here: it is the eligibility gate's
 * record of what the brand may promote, and it is written by its own flow. The
 * route passes the stored one through so saving a brand cannot erase it.
 */

const colour = z.string().regex(/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/, "Use a hex colour such as #C9B79C");

const schema = z.object({
  name: z.string().trim().min(1, "The brand needs a name").max(120),
  colors: z
    .record(z.string().regex(COLOR_NAME, "Use a name such as ink or sand"), colour)
    .default({}),
  fonts: z
    .object({
      display: z.string().trim().max(80).default(""),
      body: z.string().trim().max(80).default(""),
      mono: z.string().trim().max(80).default(""),
    })
    .default({ display: "", body: "", mono: "" }),
  voice: z
    .object({
      sample: z.string().trim().max(4000).default(""),
      tone: z.array(z.string().trim().max(40)).max(20).default([]),
    })
    .default({ sample: "", tone: [] }),
  persona: z
    .object({
      positioning: z.string().trim().max(600).default(""),
      audience: z.string().trim().max(600).default(""),
      promise: z.string().trim().max(600).default(""),
      avoids: z.array(z.string().trim().max(80)).max(12).default([]),
    })
    .default({ positioning: "", audience: "", promise: "", avoids: [] }),
  notes: z.string().trim().max(2000).default(""),
});

async function authorised(siteId: string) {
  const userId = await getUserIdFromCookies();
  if (!userId) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!(await userOwnsSite(siteId, userId))) {
    return { response: Response.json({ error: "Site not found" }, { status: 404 }) };
  }
  return {};
}

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const denied = await authorised(siteId);
  if (denied.response) return denied.response;

  const record = await readSiteBrand(db, siteId);
  return Response.json({
    brand: record?.brand ?? null,
    configured: record?.configured ?? false,
    revision: record?.revision ?? null,
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const denied = await authorised(siteId);
  if (denied.response) return denied.response;

  try {
    const input = schema.parse(await req.json());
    const existing = await readSiteBrand(db, siteId);
    const record = await saveSiteBrand(db, siteId, {
      brand: {
        ...(existing?.brand ?? {}),
        ...input,
        // The logo is an asset, not a text field: it is uploaded and stored
        // elsewhere, the panel does not show it, and parsing a brand block
        // without one drops it. Saving this form deleted Susi's logo once, and
        // a brand with no logo is refused by the renderer outright.
        logo: existing?.brand?.logo ?? null,
      },
      representation: existing?.representation ?? emptyRepresentation(),
    });
    return Response.json({ brand: record.brand, revision: record.revision });
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const field = issue?.path.join(".");
      return Response.json(
        { error: field ? `${field}: ${issue.message}` : issue?.message ?? "Invalid brand profile" },
        { status: 400 },
      );
    }
    console.error("Brand profile save error:", error);
    return Response.json({ error: "Could not save the brand profile" }, { status: 500 });
  }
}
