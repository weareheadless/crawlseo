import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsSite } from "@/lib/auth/research-action-access";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import {
  extractDesignProfileFromRepo,
  getStoredDesignProfile,
  saveDesignProfile,
  type SiteDesignProfile,
} from "@/lib/design/profile";
import { z } from "zod";
import { ZodError } from "zod";

const schema = z.object({
  notes: z.string().max(4_000).optional(),
  refresh: z.boolean().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  return Response.json({ profile: await getStoredDesignProfile(siteId) });
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
    const existing = await getStoredDesignProfile(siteId);

    if (input.refresh) {
      const config = await getSiteDeliveryConfig(siteId);
      if (!config?.repoPath) {
        return Response.json({ error: "Configure a source repository before refreshing" }, { status: 409 });
      }
      const extracted = await extractDesignProfileFromRepo(config.repoPath);
      const profile = await saveDesignProfile(siteId, {
        ...extracted,
        // A human note survives a refresh; the extracted facts do not.
        notes: existing?.notes ?? "",
      });
      return Response.json({ profile });
    }

    if (input.notes === undefined) {
      return Response.json({ error: "Nothing to save" }, { status: 400 });
    }
    const base: SiteDesignProfile = existing ?? {
      source: "human",
      repoPath: null,
      palette: [],
      fonts: [],
      notes: "",
      scannedFiles: 0,
      skippedFiles: 0,
      updatedAt: new Date().toISOString(),
    };
    const profile = await saveDesignProfile(siteId, {
      ...base,
      source: "human",
      notes: input.notes.trim(),
      updatedAt: new Date().toISOString(),
    });
    return Response.json({ profile });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid design profile" }, { status: 400 });
    }
    console.error("Design profile save error:", error);
    return Response.json({ error: "Could not save the design profile" }, { status: 500 });
  }
}
