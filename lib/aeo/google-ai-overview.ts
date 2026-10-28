import { DataForSeoRequestError, fetchGoogleSerp } from "@/lib/dataforseo/serp";

export type GoogleAiOverviewState = "succeeded" | "overview_absent" | "request_failed" | "rate_limited" | "over_budget";
export type GoogleAiOverviewResult = {
  state: GoogleAiOverviewState;
  provider: "google_ai_overview";
  question: string;
  locale: { languageCode: string; locationCode: number };
  device: "desktop" | "mobile";
  costMicros: number | null;
  taskId: string | null;
  answerText: string | null;
  citations: string[] | null;
  referencedDomains: string[] | null;
  brandPresent: boolean | null;
  error: string | null;
};
export type EvaluateGoogleAiOverviewInput = {
  projectId: string;
  question: string;
  locale: { languageCode: string; locationCode: number };
  device: "desktop" | "mobile";
  brand?: string | null;
  aliases?: string[];
  /** Caller may deny a paid request after applying the run's budget policy. */
  overBudget?: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}
function collectUrls(value: unknown, output: string[], depth = 0): void {
  if (depth > 4 || output.length >= 100) return;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 100)) collectUrls(entry, output, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const key of ["url", "link", "source_url"]) {
    const url = string(item[key], 2_000);
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") output.push(parsed.toString());
      } catch { /* Ignore malformed provider links. */ }
    }
  }
  for (const key of ["items", "references", "sources", "citations"]) collectUrls(item[key], output, depth + 1);
}
function resultBase(input: EvaluateGoogleAiOverviewInput, state: GoogleAiOverviewState, error: string | null = null): GoogleAiOverviewResult {
  return {
    state, provider: "google_ai_overview", question: input.question,
    locale: input.locale, device: input.device, costMicros: null, taskId: null,
    answerText: null, citations: null, referencedDomains: null, brandPresent: null, error,
  };
}

/** Ask one pinned Google SERP and normalize the AI Overview evidence without persistence or retries. */
export async function evaluateGoogleAiOverviewQuestion(input: EvaluateGoogleAiOverviewInput): Promise<GoogleAiOverviewResult> {
  if (input.overBudget) return resultBase(input, "over_budget", "Google AI Overview request denied by budget policy");
  try {
    const response = await fetchGoogleSerp({
      projectId: input.projectId,
      question: input.question,
      languageCode: input.locale.languageCode,
      locationCode: input.locale.locationCode,
      device: input.device,
    });
    const root = record(response.payload);
    const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
    const task = record(tasks[0]);
    const results = task && Array.isArray(task.result) ? task.result : [];
    const result = record(results[0]);
    if (!result || !Array.isArray(result.items)) {
      return { ...resultBase(input, "request_failed", "DataForSEO SERP payload has no result items"), costMicros: response.costMicros, taskId: response.taskId };
    }
    const overview = result.items.map(record).find((item) => item?.type === "ai_overview");
    if (!overview) return { ...resultBase(input, "overview_absent"), costMicros: response.costMicros, taskId: response.taskId };

    const answerText = string(overview.text ?? overview.markdown ?? overview.description ?? overview.title, 50_000);
    if (!answerText) return { ...resultBase(input, "request_failed", "DataForSEO AI Overview item contained no answer text"), costMicros: response.costMicros, taskId: response.taskId };
    const urls: string[] = [];
    collectUrls(overview, urls);
    const citations = [...new Set(urls)].slice(0, 100);
    const referencedDomains = [...new Set(citations.flatMap((url) => {
      try { return [new URL(url).hostname.toLowerCase().replace(/^www\./, "")]; } catch { return []; }
    }))].slice(0, 100);
    const targets = [input.brand, ...(input.aliases ?? [])].filter((value): value is string => Boolean(value?.trim()));
    const brandPresent = targets.length ? targets.some((target) => answerText.toLocaleLowerCase().includes(target.trim().toLocaleLowerCase())) : null;
    return {
      state: "succeeded", provider: "google_ai_overview", question: input.question,
      locale: input.locale, device: input.device, costMicros: response.costMicros,
      taskId: response.taskId, answerText, citations, referencedDomains, brandPresent, error: null,
    };
  } catch (error) {
    if (error instanceof DataForSeoRequestError) {
      const state: GoogleAiOverviewState = error.kind === "rate_limited" ? "rate_limited" : "request_failed";
      return resultBase(input, state, error.message);
    }
    return resultBase(input, "request_failed", "DataForSEO SERP request failed");
  }
}
