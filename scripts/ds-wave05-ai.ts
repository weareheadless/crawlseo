/**
 * Wave 0.5, DS-06 producer: AI visibility from ChatGPT with web search.
 *
 * One call per question (~$0.027 with `web_search: true`; the no-search variant
 * is $0.0007 but cannot cite anyone, so it cannot measure visibility). The answer
 * and its cited sources are recorded as `ai_visibility_observation` evidence:
 * asked and cited, asked and not cited (a real zero), or refused as unmeasured.
 *
 *   npx tsx scripts/ds-wave05-ai.ts --site <siteId> [--questions 8] [--dry-run]
 */

import { PrismaClient } from "@prisma/client";

import { decryptCredential } from "@/lib/encryption";
import { ingestAiVisibility, type AiVisibilityObservation } from "@/lib/dataforseo/ai-visibility-adapter";
import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";

const BASE = "https://api.dataforseo.com/v3";
const ENDPOINT = "/ai_optimization/chat_gpt/llm_responses/live";

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const dryRun = argv.includes("--dry-run");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--dry-run") continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  const siteId = values.get("site");
  if (!siteId) throw new Error("--site <siteId> is required");
  return {
    siteId,
    questions: Math.max(1, Math.min(Number(values.get("questions") ?? 8), 30)),
    dryRun,
    language: values.get("language") ?? "fr",
    country: values.get("country") ?? "FR",
  };
}

type CallResult = {
  answer: string;
  citations: string[];
  model: string | null;
  costUsd: number;
  taskId: string;
  payload: unknown;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();

  const site = await db.site.findUniqueOrThrow({ where: { id: args.siteId }, select: { id: true, domain: true, projectId: true } });
  if (!site.projectId) throw new Error("site is not attached to a project");
  const locale = await resolveDataForSeoLocale(site.projectId, args.language, args.country);

  const ranks = await db.evidenceRecord.findMany({
    where: { projectId: site.projectId, kind: "keyword_rank", supersededById: null },
    select: { dimensions: true, metrics: true },
  });
  const byQuery = new Map<string, number>();
  for (const row of ranks) {
    const query = (row.dimensions as { query?: string } | null)?.query;
    if (!query) continue;
    const impressions = Number((row.metrics as Record<string, { value?: number }> | null)?.["first_party:impressions"]?.value ?? 0);
    byQuery.set(query, (byQuery.get(query) ?? 0) + impressions);
  }
  const questions = [...byQuery.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.questions).map(([query]) => query);
  if (questions.length === 0) throw new Error("no queries to ask about");

  process.stdout.write(`${site.domain}: ${questions.length} questions, ${locale.languageCode}/${locale.locationCode}${args.dryRun ? " (dry run)" : ""}\n`);
  if (args.dryRun) {
    for (const question of questions) process.stdout.write(`  ${question}\n`);
    await db.$disconnect();
    return;
  }

  const credential = await db.providerCredential.findFirstOrThrow({
    where: { provider: "dataforseo", status: "ACTIVE" },
    select: { encryptedLogin: true, encryptedPassword: true },
  });
  const auth =
    "Basic " +
    Buffer.from(`${decryptCredential(credential.encryptedLogin)}:${decryptCredential(credential.encryptedPassword)}`).toString("base64");

  const host = site.domain.replace(/^www\./, "").toLowerCase();
  const calls: CallResult[] = [];

  for (const question of questions) {
    const res = await fetch(`${BASE}${ENDPOINT}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          user_prompt: `${question}. Cite les sources.`,
          model_name: "gpt-4o-mini",
          max_output_tokens: 400,
          web_search: true,
        },
      ]),
    });
    const json = (await res.json()) as {
      status_code?: number;
      tasks?: Array<{ id?: string; status_code?: number; cost?: number; result?: Array<Record<string, unknown>> }>;
    };
    const task = json.tasks?.[0];
    const result = task?.result?.[0];
    if (json.status_code !== 20000 || task?.status_code !== 20000 || !result) {
      process.stderr.write(`  ${question}: provider error ${task?.status_code ?? json.status_code}\n`);
      continue;
    }
    const items = (result.items ?? []) as Array<{ type?: string; sections?: Array<{ type?: string; text?: string }> }>;
    const answer = items
      .flatMap((item) => item.sections ?? [])
      .filter((section) => section.type === "text" && typeof section.text === "string")
      .map((section) => section.text as string)
      .join("\n")
      .trim();
    const searchResults = (result.search_results ?? []) as Array<{ url?: string }>;
    const citations = searchResults.map((row) => row.url).filter((url): url is string => Boolean(url));
    calls.push({
      answer,
      citations,
      model: typeof result.model_name === "string" ? result.model_name : null,
      costUsd: Number(task.cost ?? 0),
      taskId: task.id ?? "",
      payload: result,
    });
    process.stdout.write(`  ${question}: ${citations.length} citations, ${answer ? "answered" : "no answer"}\n`);
  }

  const askedAt = new Date();
  const observations: AiVisibilityObservation[] = calls.map((call, index) => {
    const ours = call.citations.filter((url) => url.toLowerCase().includes(host)).length;
    const competitors = call.citations.filter((url) => !url.toLowerCase().includes(host)).length;
    return {
      question: questions[index] ?? "unknown",
      surface: "chatgpt_search",
      model: call.model,
      locale: `${locale.languageCode}:${locale.locationCode}`,
      askedAt,
      // `samples` is the number of answers sampled, not the number of URLs cited:
      // with one sample, citing us is 1, not the count of our URLs.
      samples: 1,
      citationsOfUs: ours > 0 ? 1 : 0,
      citationsOfCompetitor: competitors > 0 ? 1 : 0,
      denominator: call.citations.length,
      dataset: call.taskId,
      answered: call.answer.length > 0,
      rawExportReference: `dataforseo:${call.taskId}`,
    };
  });

  const costMicros = BigInt(Math.round(calls.reduce((sum, call) => sum + call.costUsd, 0) * 1_000_000));
  const ingested = await ingestAiVisibility(db as never, observations, {
    projectId: site.projectId,
    siteId: site.id,
    requestedAt: askedAt,
    costMicros,
    providerTaskId: calls[0]?.taskId ?? "ai-visibility",
    payload: calls.map((call) => call.payload),
  });

  process.stdout.write(
    JSON.stringify(
      {
        questions: questions.length,
        calls: calls.length,
        stored: ingested.stored,
        refused: ingested.refused.length,
        costUsd: Number(costMicros) / 1_000_000,
      },
      null,
      1
    ) + "\n"
  );
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
