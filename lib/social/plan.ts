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

export type PlannerBrand = {
  name: string;
  voiceSample: string;
  tone: string[];
  services: string[];
  topics: string[];
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
  /** Photos the brand owns, by file name. */
  photos: string[];
  locales: string[];
  today: string;
};

export type PlannedPost = {
  post: true;
  reason: string;
  subject: string;
  angle: string;
  copy: { kicker: string; headline: string; subline: string; caption: string };
  claims: Array<{ text: string; source_url: string }>;
  image: string;
  artDirection: string;
};

export type PlannedNone = { post: false; reason: string };

export type PlanResult = {
  plan: PlannedPost | PlannedNone;
  /** Claims that cited something the bundle never contained. */
  droppedClaims: string[];
};

const SYSTEM = `You decide what, if anything, a real-estate brand should post today.

You are not writing a summary of the business and you are not reporting that work
was done. You choose one subject worth a buyer's attention and give it an angle.

Answer with a single JSON object and nothing else. Either:

{"post": false, "reason": "one sentence"}

or

{"post": true,
 "reason": "why this, why today, one sentence",
 "subject": "the place or project this is about",
 "angle": "the one idea the post carries",
 "copy": {"kicker": "2-5 words, location or category",
          "headline": "short, concrete, no clickbait, no question",
          "subline": "one supporting line, may be empty",
          "caption": "2-4 sentences for the post body, in the brand's voice"},
 "claims": [{"text": "a specific the caption or image asserts",
             "source_url": "the source it came from, copied from the bundle"}],
 "image": "one file name from photos",
 "art_direction": "one or two sentences for the designer"}

Rules that are checked in code, not trusted:
- subject must be one of "represented".
- image must be one of "photos".
- every claim's source_url must be a URL that appears in the bundle. A specific
  with no source is not allowed; leave it out rather than guessing.
- Do not repeat a subject or headline from "posts".
- If nothing is genuinely worth posting, answer {"post": false}. A quiet day is a
  correct answer and costs nothing. Do not invent a reason to post.`;

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
export function parsePlan(raw: unknown, input: PlannerInput): PlanResult | { error: string } {
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
  if (!headline) return { error: "the planned post has no headline" };

  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const represented = input.represented.map(normaliseName);
  if (subject && !represented.some((name) => name === normaliseName(subject))) {
    return { error: `the brand does not represent ${subject}` };
  }

  const image = typeof value.image === "string" ? value.image.trim() : "";
  if (!input.photos.includes(image)) {
    return { error: `the planner chose a photo the brand does not have: ${image || "(none)"}` };
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
      copy: {
        kicker: string("kicker"),
        headline,
        subline: string("subline"),
        caption: string("caption"),
      },
      claims,
      image,
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
};

export function plannerConfig(): { apiKey: string; model: string } | null {
  const apiKey = (process.env.PLANNER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
  const model = (process.env.PLANNER_MODEL ?? "deepseek/deepseek-v4.1-flash-1017").trim();
  if (!apiKey) return null;
  return { apiKey, model };
}

/** One call. Text in, one JSON object out. */
export async function planPost(
  input: PlannerInput,
  options: PlannerOptions = {},
): Promise<PlanResult | { error: string }> {
  const config = plannerConfig();
  const apiKey = options.apiKey ?? config?.apiKey ?? "";
  const model = options.model ?? config?.model ?? "deepseek/deepseek-v4.1-flash-1017";
  if (!apiKey) return { error: "no planner API key is configured" };
  const call = options.fetchImpl ?? fetch;

  const response = await call("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(compact(input)) },
      ],
      response_format: { type: "json_object" },
      // A reasoning model spends tokens before it writes the object; too small a
      // budget returns an empty content string rather than an error.
      max_tokens: 6000,
    }),
  });
  if (!response.ok) {
    return { error: `the planner answered ${response.status}: ${(await response.text()).slice(0, 300)}` };
  }
  const body = (await response.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning?: string } }>;
  };
  const choice = body.choices?.[0];
  const content = choice?.message?.content ?? "";
  if (!content.trim()) {
    return {
      error:
        `the planner returned no content (finish=${choice?.finish_reason ?? "?"}, ` +
        `reasoning_chars=${(choice?.message?.reasoning ?? "").length})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { error: `the planner did not return JSON: ${content.slice(0, 300)}` };
  }
  return parsePlan(parsed, input);
}
