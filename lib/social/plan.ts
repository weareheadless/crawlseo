/**
 * What should this brand post today, if anything?
 *
 * One reasoning model reads a compact bundle — the brand, its own recent posts,
 * the opportunities, the crawl digest and the research findings — and answers
 * with a structured decision. It is not a pipeline: one call, one object, and
 * the check that follows is about shape and provenance rather than taste.
 *
 * The rules the model cannot talk its way around live here, in code:
 *
 * - A claim may only cite a source that arrived in the bundle. Anything else is
 *   dropped, and the drop is reported, so a specific can never appear in a post
 *   without something it came from.
 * - The image must be one of the photos the brand actually has.
 * - The subject must be something the brand represents.
 * - "Nothing today" is a first-class answer, not a failure.
 */

import { runTool, toolDefinitions, type SocialTools } from "@/lib/social/tools";

export type PlannerBrand = {
  name: string;
  voiceSample: string;
  tone: string[];
  services: string[];
  topics: string[];
  /** What the brand is for, who it serves, what it must not become. */
  persona?: {
    positioning: string;
    audience: string;
    promise: string;
    avoids: string[];
  };
};

export type PlannerPost = { subject: string; headline: string; publishedAt: string | null };

export type PlannerOpportunity = {
  title: string;
  summary: string;
  type: string;
  status: string;
  score: number | null;
};

export type PlannerPage = { url: string; clicks: number; impressions: number; position: number };

export type PlannerFinding = {
  theme: string;
  summary: string;
  confidence: number;
  sourceUrl: string;
};

export type PlannerInput = {
  brand: PlannerBrand;
  /** Names the brand may talk about (places, services, represented projects). */
  represented: string[];
  posts: PlannerPost[];
  opportunities: PlannerOpportunity[];
  crawl: PlannerPage[];
  research: PlannerFinding[];
  /** Photos the brand owns, with what is in them. A name alone is not a choice. */
  photos: Array<{ file: string; description: string }>;
  locales: string[];
  today: string;
};

export type PlannedPost = {
  post: true;
  reason: string;
  subject: string;
  angle: string;
  /** A hint at most: editorial writes the copy the post carries. */
  copy?: { kicker: string; headline: string; subline: string; caption: string };
  claims: Array<{ text: string; source_url: string }>;
  /** A URL the tools returned, or a catalogue file name. */
  imageUrl: string;
  image: string;
  imageNote: string;
  artDirection: string;
};

export type PlannedNone = { post: false; reason: string };

export type PlanResult = {
  plan: PlannedPost | PlannedNone;
  /** Claims that cited something the bundle never contained. */
  droppedClaims: string[];
};

const SYSTEM = `You are the social editor for a real-estate brand. You decide what, if
anything, the brand posts today, and you choose the photograph. The copy is written
by the desk that owns the brand's voice, from your decision and its evidence, so
your job is to make the decision stand up: a subject the brand may promote, one
angle, and the sources that support it.

You have tools. Use them, in this order:
1. find_page — search the site's own pages. Use the place name from your subject,
   then list_site_pages if the search is empty.
2. read_page — open the page you found. You get its title, its description and
   every image it shows, with alt text and size. Choose from those images.
3. search_photos — a stock library, only when the site has no page about the
   subject, or no usable photograph in the page.
4. list_brand_photos — the brand's own files, described. Last resort: they are a
   handful of generic shots and usually not of the subject.

A photograph has to be of the thing the post is about: the building, the beach,
the street the headline names. Not a pool, not an interior, not a skyline, never a
logo. If you choose from the brand's catalogue or from stock, "image_note" must
say why that picture is still of this subject and where it came from — if you
cannot say it, choose something else. Do not skip read_page because a catalogue is
quicker.

Answer, when you are done, with a single JSON object and nothing else. Either:

{"post": false, "reason": "one sentence"}

or

{"post": true,
 "reason": "why this, why today",
 "subject": "the place or project this is about",
 "angle": "the one idea the post carries",
 "claims": [{"text": "a specific the post asserts", "source_url": "URL from the bundle or from a page you read"}],
 "image_url": "https://... the photograph you chose, from read_page or search_photos",
 "image": "or a file name from list_brand_photos, if that is the better picture",
 "image_note": "why this picture, and where it came from"}

Rules checked in code:
- subject must be one of "represented".
- image_url must be a URL a tool returned; image must be a catalogue file. One of them is required.
- claims must cite a URL from the bundle or a page you read.
- Do not repeat a subject or headline from "posts".
- {"post": false} is a correct answer on a quiet day.`;

function compact(input: PlannerInput) {
  return {
    today: input.today,
    brand: input.brand,
    represented: input.represented,
    locales: input.locales,
    recent_posts: input.posts,
    opportunities: input.opportunities,
    crawl: input.crawl,
    research: input.research,
    photos: input.photos,
  };
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase();
}

/** Every source the bundle can vouch for. */
function bundleSources(input: PlannerInput): Set<string> {
  const urls = new Set<string>();
  for (const finding of input.research) if (finding.sourceUrl) urls.add(finding.sourceUrl.trim());
  for (const page of input.crawl) if (page.url.startsWith("http")) urls.add(page.url.trim());
  return urls;
}

/**
 * The model's answer, checked. Everything it can get wrong about shape or
 * provenance is caught here; nothing about taste is.
 */
export type AllowedImages = { urls: Set<string>; files: Set<string> };

export function allowedImages(input: PlannerInput, discovered?: Iterable<string>): AllowedImages {
  return {
    urls: new Set(discovered ?? []),
    files: new Set(input.photos.map((photo) => photo.file)),
  };
}

export function parsePlan(
  raw: unknown,
  input: PlannerInput,
  allowed: AllowedImages = allowedImages(input),
): PlanResult | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "the planner returned no object" };
  const value = raw as Record<string, unknown>;

  if (value.post === false) {
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    if (!reason) return { error: "a decision to post nothing must say why" };
    return { plan: { post: false, reason }, droppedClaims: [] };
  }
  if (value.post !== true) return { error: "the planner did not answer post: true or false" };

  const copy = (value.copy ?? {}) as Record<string, unknown>;
  const headline = typeof copy.headline === "string" ? copy.headline.trim() : "";

  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const represented = input.represented.map(normaliseName);
  if (subject && !represented.some((name) => name === normaliseName(subject))) {
    return { error: `the brand does not represent ${subject}` };
  }

  const imageUrl = typeof value.image_url === "string" ? value.image_url.trim() : "";
  const image = typeof value.image === "string" ? value.image.trim() : "";
  if (imageUrl && !allowed.urls.has(imageUrl)) {
    return { error: `the editor chose an image no tool returned: ${imageUrl}` };
  }
  if (!imageUrl && !allowed.files.has(image)) {
    return { error: `the editor chose a photo the brand does not have: ${image || "(none)"}` };
  }

  const sources = bundleSources(input);
  const droppedClaims: string[] = [];
  const claims: Array<{ text: string; source_url: string }> = [];
  for (const item of Array.isArray(value.claims) ? value.claims : []) {
    if (!item || typeof item !== "object") continue;
    const claim = item as Record<string, unknown>;
    const text = typeof claim.text === "string" ? claim.text.trim() : "";
    const source = typeof claim.source_url === "string" ? claim.source_url.trim() : "";
    if (!text) continue;
    if (!source || !sources.has(source)) {
      droppedClaims.push(text);
      continue;
    }
    claims.push({ text, source_url: source });
  }

  const string = (key: string) => (typeof copy[key] === "string" ? String(copy[key]).trim() : "");

  return {
    plan: {
      post: true,
      reason: typeof value.reason === "string" ? value.reason.trim() : "",
      subject,
      angle: typeof value.angle === "string" ? value.angle.trim() : "",
      ...(headline
        ? {
            copy: {
              kicker: string("kicker"),
              headline,
              subline: string("subline"),
              caption: string("caption"),
            },
          }
        : {}),
      claims,
      imageUrl,
      image,
      imageNote: typeof value.image_note === "string" ? value.image_note.trim() : "",
      artDirection:
        typeof value.art_direction === "string" ? value.art_direction.trim() : "",
    },
    droppedClaims,
  };
}

export type PlannerOptions = {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** The tools the editor may call. Without them it answers from the bundle. */
  tools?: SocialTools;
  maxSteps?: number;
};

export function plannerConfig(): { apiKey: string; model: string } | null {
  const apiKey = (process.env.PLANNER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
  const model = (process.env.PLANNER_MODEL ?? "deepseek/deepseek-v4.1-flash-1017").trim();
  if (!apiKey) return null;
  return { apiKey, model };
}

type ChatMessage = Record<string, unknown>;

async function complete(
  call: typeof fetch,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ message: ChatMessage; error?: string }> {
  const response = await call("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return { message: {}, error: `the editor answered ${response.status}: ${(await response.text()).slice(0, 300)}` };
  }
  const payload = (await response.json()) as {
    choices?: Array<{ finish_reason?: string; message?: ChatMessage }>;
  };
  const message = payload.choices?.[0]?.message;
  if (!message) return { message: {}, error: "the editor returned no message" };
  return { message };
}

/**
 * Tool calls written into the message instead of the native field.
 *
 * A model that has native tools still sometimes answers with
 * `{"tool_calls":[{"name":"read_page","params":{"url":"..."}}]}` as plain text.
 * Reading that as a final answer loses the tool call and the page it wanted; so
 * both shapes are executed the same way.
 */
export function embeddedCalls(content: string): Array<{ name: string; args: Record<string, unknown> }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const value = parsed as Record<string, unknown>;
  if ("post" in value) return [];

  const asObject = (input: unknown): Record<string, unknown> =>
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  const calls = value.tool_calls;
  if (Array.isArray(calls)) {
    return calls
      .map((entry) => {
        const row = asObject(entry);
        const fn = asObject(row.function);
        const name = String(row.name ?? fn.name ?? "");
        const args = row.arguments ?? row.params ?? row.args ?? fn.arguments ?? {};
        return { name, args: typeof args === "string" ? asObject(safeParse(args)) : asObject(args) };
      })
      .filter((call) => call.name);
  }

  const single = value.tool ?? value.tool_name ?? value.name;
  if (typeof single === "string" && single) {
    const rest = { ...value };
    delete rest.tool;
    delete rest.tool_name;
    delete rest.name;
    const args = value.args ?? value.params ?? value.arguments;
    return [{ name: single, args: typeof args === "string" ? asObject(safeParse(args)) : asObject(args ?? rest) }];
  }
  return [];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** URLs an image-bearing tool returned, so a choice can be checked. */
export function imagesIn(result: unknown, into: Set<string>): void {
  if (!result || typeof result !== "object") return;
  const seen = result as {
    images?: Array<{ url?: string }>;
    photos?: Array<{ url?: string }>;
    pages?: Array<{ images?: Array<{ url?: string }> }>;
  };
  for (const image of seen.images ?? []) if (image?.url) into.add(String(image.url));
  for (const photo of seen.photos ?? []) if (photo?.url) into.add(String(photo.url));
  // find_page returns pages with their images nested.
  for (const page of seen.pages ?? []) {
    for (const image of page?.images ?? []) if (image?.url) into.add(String(image.url));
  }
}

/**
 * One decision, made with access to the site and the brand's photographs.
 *
 * The editor calls tools, reads what it needs, and answers with the plan and the
 * photograph it chose. The loop is bounded: an editor that will not stop is an
 * editor that will not answer.
 */
export async function planPost(
  input: PlannerInput,
  options: PlannerOptions = {},
): Promise<PlanResult | { error: string }> {
  const config = plannerConfig();
  const apiKey = options.apiKey ?? config?.apiKey ?? "";
  const model = options.model ?? config?.model ?? "deepseek/deepseek-v4.1-flash-1017";
  if (!apiKey) return { error: "no planner API key is configured" };
  const call = options.fetchImpl ?? fetch;
  const tools = options.tools;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify(compact(input)) },
  ];
  const discovered = new Set<string>();

  for (let step = 0; step < (options.maxSteps ?? 8); step += 1) {
    const { message, error } = await complete(call, apiKey, {
      model,
      messages,
      max_tokens: 6000,
      ...(tools ? { tools: toolDefinitions({ stock: Boolean(tools.searchPhotos) }) } : {}),
      ...(!tools || step > 0 ? { response_format: { type: "json_object" } } : {}),
    });
    if (error) return { error };

    const calls = message.tool_calls as Array<{
      id: string;
      function: { name: string; arguments?: string };
    }> | undefined;

    if (tools && calls && calls.length > 0) {
      messages.push(message);
      for (const call_ of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call_.function.arguments ?? "{}");
        } catch {
          args = {};
        }
        const result = await runTool(call_.function.name, args, tools);
        imagesIn(result, discovered);
        const summary = result as { count?: number; images?: unknown[]; photos?: unknown[]; error?: string };
        console.error(
          `[editor] ${call_.function.name}(${JSON.stringify(args).slice(0, 80)}) -> ` +
            (summary.error ?? `${summary.count ?? summary.images?.length ?? summary.photos?.length ?? 0} items`),
        );
        messages.push({
          role: "tool",
          tool_call_id: call_.id,
          // A sitemap of 373 pages is ~28KB and is the whole point of the tool:
          // cutting it in half hides the page the editor is looking for.
          content: JSON.stringify(result).slice(0, 60_000),
        });
      }
      continue;
    }

    const content = String(message.content ?? "");
    if (process.env.PLANNER_DEBUG) {
      console.error(`[editor] step ${step} answer: ${content.slice(0, 500)}`);
    }
    if (!content.trim()) {
      return { error: `the editor returned no answer (finish=${message.finish_reason ?? "?"})` };
    }
    const embedded = embeddedCalls(content);
    if (tools && embedded.length > 0) {
      messages.push({ role: "assistant", content });
      for (const call of embedded) {
        const result = await runTool(call.name, call.args, tools);
        imagesIn(result, discovered);
        messages.push({
          role: "user",
          content: `TOOL RESULT ${call.name}: ${JSON.stringify(result).slice(0, 60_000)}`,
        });
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    const checked = parsed === null
      ? { error: `that was not JSON: ${content.slice(0, 200)}` }
      : parsePlan(parsed, input, allowedImages(input, discovered));
    if ("error" in checked) {
      // One correction, naming what was wrong. An editor that answers in prose
      // after its tools is a formatting miss, not a refusal to decide.
      if (step < (options.maxSteps ?? 8) - 1) {
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: `That answer was rejected: ${checked.error}. Answer again with the JSON object only, no prose.`,
        });
        continue;
      }
      return checked;
    }
    return checked;
  }
  return { error: "the editor kept calling tools and never answered" };
}
