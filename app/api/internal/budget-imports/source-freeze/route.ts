import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { freezeLegacyBudgetSourceDispatch, getLegacyBudgetSourceFreezeReceipt, LegacyBudgetImportError } from "@/lib/billing/legacy-budget-import";

const schema = z.object({
  mode: z.enum(["freeze-source-plan", "freeze-source-apply"]),
  sourceProjectId: z.string().trim().min(1).max(64),
  sourceSiteId: z.string().trim().min(1).max(64),
  targetSiteId: z.string().trim().min(1).max(64),
  expectedBindingGeneration: z.number().int().positive(),
  expectedSourcePolicyHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
}).strict();
const noStore = { "Cache-Control": "no-store" };

function authorized(req: Request): boolean {
  const expected = process.env.HELLOADA_PROVISIONING_TOKEN;
  const supplied = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!expected || !supplied) return false;
  return timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(supplied).digest());
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  let input: z.infer<typeof schema>;
  try { input = schema.parse(await req.json()); }
  catch (error) {
    return Response.json({ error: error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid request" : "Invalid request" }, { status: 400, headers: noStore });
  }
  if (input.mode === "freeze-source-apply" && !input.expectedSourcePolicyHash) {
    return Response.json({ error: "Freeze apply requires the source policy hash returned by plan" }, { status: 400, headers: noStore });
  }
  try {
    return Response.json(await freezeLegacyBudgetSourceDispatch(input), { headers: noStore });
  } catch (error) {
    if (error instanceof LegacyBudgetImportError) return Response.json({ error: error.message }, { status: error.statusCode, headers: noStore });
    return Response.json({ error: "Source dispatch freeze failed" }, { status: 500, headers: noStore });
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  const receiptId = new URL(req.url).searchParams.get("receiptId")?.trim();
  if (!receiptId || receiptId.length > 64) return Response.json({ error: "receiptId is required" }, { status: 400, headers: noStore });
  try {
    const receipt = await getLegacyBudgetSourceFreezeReceipt(receiptId);
    return receipt ? Response.json(receipt, { headers: noStore })
      : Response.json({ error: "Source freeze receipt not found" }, { status: 404, headers: noStore });
  } catch {
    return Response.json({ error: "Source freeze receipt lookup failed" }, { status: 500, headers: noStore });
  }
}
