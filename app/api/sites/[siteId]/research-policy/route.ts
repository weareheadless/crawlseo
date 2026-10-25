import { getUserIdFromCookies } from "@/lib/session-helper";
import {
  DEFAULT_RESEARCH_CADENCE,
  getResearchConfig,
  saveResearchConfig,
} from "@/lib/research/policy";
import { z } from "zod";
import { ZodError } from "zod";
import { userOwnsSite } from "@/lib/auth/research-action-access";

const schema = z.object({
  topics: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  audience: z.string().trim().max(300).optional().default(""),
  market: z.string().trim().max(120).optional().default(""),
  language: z.string().trim().min(2).max(16).default("en"),
  providers: z.array(z.enum(["reddit", "news"])).min(1).max(2).default(["reddit", "news"]),
  cadence: z.enum(["daily", "weekly", "monthly", "manual"]).default(DEFAULT_RESEARCH_CADENCE),
  enabled: z.boolean().default(true),
  maxSources: z.number().int().min(1).max(100).default(30),
  monthlyBudget: z.number().int().min(0).max(500).default(9),
  autoDraft: z.boolean().default(false),
  autoAgent: z.boolean().default(false),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  try {
    return Response.json(await getResearchConfig(siteId));
  } catch {
    return Response.json({ error: "Site not found" }, { status: 404 });
  }
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
    const policy = await saveResearchConfig(siteId, input);
    return Response.json({ policy });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid research config" }, { status: 400 });
    }
    console.error("Research config error:", error);
    return Response.json({ error: "Failed to save research config" }, { status: 500 });
  }
}
