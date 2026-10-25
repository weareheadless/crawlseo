import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getLegacyBudgetImportReceipt, importLegacyBudget, LegacyBudgetImportError } from "@/lib/billing/legacy-budget-import";

const rowSchema = z.object({
  localReservationId: z.string().trim().min(1).max(240),
  taskId: z.string().trim().min(1).max(64),
  operation: z.enum(["dataforseo:article_keyword_overview", "dataforseo:article_serp_snapshot"]),
  legacyStatus: z.enum(["reserved", "settled", "uncertain", "released"]),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  timeZone: z.string().trim().min(1).max(100),
  currency: z.string().trim().length(3),
  amountMicros: z.string().regex(/^(0|[1-9][0-9]*)$/).max(40),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  settledAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

const importRequestSchema = z.object({
  mode: z.enum(["plan", "apply"]),
  sourceProjectId: z.string().trim().min(1).max(64),
  sourceSiteId: z.string().trim().min(1).max(64),
  targetSiteId: z.string().trim().min(1).max(64),
  expectedBindingGeneration: z.number().int().positive(),
  expectedSourceEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
  rows: z.array(rowSchema).min(1).max(100),
}).strict();
const requestSchema = importRequestSchema;

const noStore = { "Cache-Control": "no-store" };

function authorized(req: Request): boolean {
  const configured = process.env.HELLOADA_PROVISIONING_TOKEN;
  const supplied = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !supplied) return false;
  return timingSafeEqual(
    createHash("sha256").update(configured).digest(),
    createHash("sha256").update(supplied).digest(),
  );
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await req.json());
  } catch (error) {
    return Response.json({ error: error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid request" : "Invalid request" }, {
      status: 400, headers: noStore,
    });
  }
  if (input.mode === "apply" && !input.expectedSourceEvidenceHash) {
    return Response.json({ error: "Apply requires the source evidence hash returned by plan" }, {
      status: 400, headers: noStore,
    });
  }
  try {
    const result = await importLegacyBudget({ ...input,
      rows: input.rows.map((row) => ({ ...row, currency: row.currency.toUpperCase() })) });
    return Response.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof LegacyBudgetImportError) {
      return Response.json({ error: error.message }, { status: error.statusCode, headers: noStore });
    }
    return Response.json({ error: "Legacy budget import failed" }, { status: 500, headers: noStore });
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  const params = new URL(req.url).searchParams;
  const receiptId = params.get("receiptId")?.trim();
  if (!receiptId || receiptId.length > 64) {
    return Response.json({ error: "receiptId is required" }, { status: 400, headers: noStore });
  }
  try {
    const receipt = await getLegacyBudgetImportReceipt(receiptId);
    return receipt
      ? Response.json(receipt, { headers: noStore })
      : Response.json({ error: "Import receipt not found" }, { status: 404, headers: noStore });
  } catch {
    return Response.json({ error: "Legacy budget receipt lookup failed" }, { status: 500, headers: noStore });
  }
}
