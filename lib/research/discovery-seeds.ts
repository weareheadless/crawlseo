import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";

/**
 * Search seeds for a site with no measured demand.
 *
 * Search Console cannot seed discovery when it has two queries, and the owner's
 * service labels are navigation text, not search phrases: `Private freediving
 * coaching Playa del Carmen` returns zero keywords from the provider while
 * `freediving Playa del Carmen` returns eight. The provider only expands phrases
 * that people actually type, so something has to turn the business into market
 * language. That is a judgement call about the business, which is what the model
 * is for.
 *
 * A deterministic fallback (service + area) is kept for when the call fails, and
 * the caller reports which one produced the seeds.
 */

export type DiscoverySeedInput = {
  domain: string;
  language: string;
  businessName: string | null;
  services: string[];
  location: string | null;
  serviceArea: string[];
  audience: string | null;
  /** Page titles and H1s: how the site already talks about its work. */
  pageTitles: string[];
  /** Phrases already measured, so the model does not spend a seed on them. */
  knownQueries: string[];
  limit: number;
};

export type DiscoverySeedResult = {
  seeds: string[];
  source: "model" | "fallback";
  model: string | null;
  error: string | null;
};

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Service + area, used when the model call is unavailable. */
export function fallbackSeeds(input: DiscoverySeedInput): string[] {
  const area = input.serviceArea[0] ?? input.location ?? "";
  const known = new Set(input.knownQueries.map(normalize));
  const seeds: string[] = [];
  for (const service of input.services) {
    const phrase = service.trim();
    if (!phrase) continue;
    // Keep the last three words: the head of a long label is usually the
    // qualifier ("Private", "One-to-one"), which nobody searches for.
    const head = phrase.split(/\s+/).slice(-3).join(" ");
    const seed = area ? `${head} ${area}` : head;
    if (known.has(normalize(seed)) || seeds.some((existing) => normalize(existing) === normalize(seed))) continue;
    seeds.push(seed);
  }
  return seeds.slice(0, input.limit);
}

export async function proposeDiscoverySeeds(input: DiscoverySeedInput): Promise<DiscoverySeedResult> {
  const fallback = fallbackSeeds(input);
  const config = contentWriterConfig();
  if (!config) {
    return { seeds: fallback, source: "fallback", model: null, error: "CONTENT_LLM_API_KEY is not configured" };
  }

  const payload = {
    domain: input.domain,
    language: input.language,
    business: {
      name: input.businessName,
      services: input.services,
      location: input.location,
      serviceArea: input.serviceArea,
      audience: input.audience,
    },
    pageTitles: input.pageTitles.slice(0, 40),
    alreadyMeasured: input.knownQueries.slice(0, 40),
    limit: input.limit,
  };
  const system = [
    "You turn a business into the short search phrases its buyers type.",
    "You are given the owner's services, location and page titles. The services are navigation labels, often too long to be searched.",
    "Return the shortest phrases a buyer would type into Google: one to three words, in the site language. The head term matters most.",
    "A long phrase is not a keyword. The provider only expands phrases that exist in its index, so 'freediving course Playa del Carmen' returns nothing while 'freediving' returns thousands of searches a month and expands to every place variant.",
    "Prefer the trade word on its own (freediving, ceramics, roofing), then the trade with the place, then one specific service. Do not include the brand name. Do not repeat a phrase already measured.",
    `Return exactly one JSON object: { seeds: string[] } with at most ${input.limit} entries, most valuable first.`,
  ].join("\n");

  try {
    const parsed = await chatJson({
      config,
      system,
      user: JSON.stringify(payload),
      maxTokens: 4_000,
      temperature: 0.2,
      attempts: 2,
      timeoutMs: 90_000,
      jsonMode: false,
    });
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const rows = Array.isArray(record.seeds) ? record.seeds : [];
    const known = new Set(input.knownQueries.map(normalize));
    const seeds: string[] = [];
    for (const row of rows) {
      if (typeof row !== "string") continue;
      const seed = row.trim().replace(/\s+/g, " ");
      if (!seed || seed.length > 70) continue;
      // A seed longer than four words is a sentence, and the provider will not
      // expand it: it returns nothing for phrases that are not in its index.
      if (seed.split(/\s+/).length > 4) continue;
      const key = normalize(seed);
      if (!key || known.has(key) || seeds.some((existing) => normalize(existing) === key)) continue;
      seeds.push(seed);
    }
    if (seeds.length === 0) {
      return { seeds: fallback, source: "fallback", model: config.model, error: "the model returned no usable seed" };
    }
    return { seeds: seeds.slice(0, input.limit), source: "model", model: config.model, error: null };
  } catch (error) {
    return {
      seeds: fallback,
      source: "fallback",
      model: config.model,
      error: error instanceof Error ? error.message.slice(0, 200) : "seed proposal failed",
    };
  }
}
