import { z } from "zod";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import {
  assertNegotiatedWixBridgeOperations,
  readBridgePageSeo,
  setBridgePageSeo,
  type BridgePageSeo,
} from "@/lib/bridge/client";
import { decodeEntities, liveDescription, liveTitle, readLivePage } from "@/lib/delivery/wix-early-packet";
import { renderPageText } from "@/lib/delivery/wix-render";

/**
 * A pushed page is not finished without its own title and meta description.
 * Wix falls back to a page-type pattern ("abat-jour sur mesure | Atelier de
 * l'Harmonie") and no description at all, which is what search engines then
 * show. The page's copy is a fact; the model turns it into a title and a
 * description, and the code checks what the live page actually serves.
 */

export const PageSeoTextSchema = z.object({
  title: z.string().trim().min(10).max(200),
  description: z.string().trim().min(50).max(400),
});

export type PageSeoText = z.infer<typeof PageSeoTextSchema>;

export type PageSeoResult = {
  status: "present" | "updated" | "failed";
  route: string;
  pageId?: string;
  title: string | null;
  description: string | null;
  source: "page" | "supplied" | "model" | "none";
  error?: string;
};

/** The readable copy of a page fragment or document. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function firstHeading(html: string): string | null {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const heading = match ? htmlToText(match[1]) : "";
  return heading || null;
}

type PageSeoContext = {
  siteName: string;
  language: string;
  route: string;
  pageTitle: string | null;
  text: string;
};

/**
 * The model reads the page; the code validates the shape and the length. It is
 * asked for the two fields only, in the page's language, and told not to invent
 * a fact the page does not state.
 */
export function buildPageSeoPrompt(input: PageSeoContext): { system: string; user: string } {
  const system = [
    `You write search titles and meta descriptions for ${input.siteName}.`,
    `Write in ${input.language}. Return only JSON: {"title": "...", "description": "..."}.`,
    "Title: 35 to 65 characters, the page's own promise first, the brand last only if it fits.",
    "Description: 120 to 160 characters, one sentence or two, concrete, no call to action cliché.",
    "Use only facts stated in the page copy or the route. Never invent a price, a date, a certification, a place or a superlative.",
    "Do not repeat the same wording in both fields.",
  ].join("\n");
  const user = JSON.stringify({
    route: input.route,
    page_title: input.pageTitle,
    page_text: input.text.slice(0, 12_000),
  });
  return { system, user };
}

/** Ask the model for the page's two fields, with one retry when the shape is wrong. */
export async function generatePageSeo(input: PageSeoContext): Promise<PageSeoText> {
  const config = contentWriterConfig();
  if (!config) throw new Error("No content model is configured, so the page title and description cannot be written.");
  const { system, user } = buildPageSeoPrompt(input);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await chatJson({
      config,
      system,
      user: attempt === 0 ? user : `${user}\n\nThe previous answer was rejected: ${lastError}`,
      maxTokens: 600,
      temperature: 0.3,
    });
    const parsed = PageSeoTextSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastError = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  }
  throw new Error(`The model did not return a usable title and description (${lastError}).`);
}

function sameText(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

/** What the live page currently serves, without running its scripts. */
export async function livePageSeo(url: string): Promise<{ title: string | null; description: string | null } | null> {
  const html = await readLivePage(url);
  if (html === null) return null;
  return { title: liveTitle(html), description: liveDescription(html) };
}

/**
 * Make sure a static page carries its own title and meta description.
 *
 * A page with its own override keeps whatever a human wrote; only a missing
 * field is filled. A page that still inherits the Wix pattern gets both fields
 * written from its copy. The result is read back from the live document,
 * because the SEO API's response is not a rendered-page check.
 */
export async function ensurePageSeo(input: {
  alias: string;
  route: string;
  url: string;
  siteName: string;
  language?: string;
  /** The page copy to describe. When absent, the live page is read. */
  html?: string | null;
  /** Known values from the page's brief; the model is skipped when both exist. */
  seo?: { title?: string | null; description?: string | null } | null;
  /** The page's own heading, when the caller already knows it. */
  pageTitle?: string | null;
  /** How long to wait before the one re-read of the live page. */
  retryDelayMs?: number;
}): Promise<PageSeoResult> {
  await assertNegotiatedWixBridgeOperations(input.alias, ["seo_tags"]);
  const current: BridgePageSeo = await readBridgePageSeo(input.alias, input.route);
  const owned = current.hasOverride === true;
  const existingTitle = owned && current.currentTitle ? current.currentTitle.trim() : "";
  const existingDescription = owned && current.currentDescription ? current.currentDescription.trim() : "";

  // The saved tags and the published page are two revisions: a site publish
  // can restore an older one, so "saved" is not "served". The live document
  // decides whether there is anything to do.
  const liveBefore = existingTitle && existingDescription ? await livePageSeo(input.url) : null;
  if (
    existingTitle &&
    existingDescription &&
    (liveBefore === null || (sameText(liveBefore.title, existingTitle) && sameText(liveBefore.description, existingDescription)))
  ) {
    return {
      status: "present",
      route: input.route,
      pageId: current.pageId,
      title: existingTitle,
      description: existingDescription,
      source: "page",
    };
  }

  const suppliedTitle = input.seo?.title?.trim() || "";
  const suppliedDescription = input.seo?.description?.trim() || "";

  let title = existingTitle || suppliedTitle;
  let description = existingDescription || suppliedDescription;
  let source: PageSeoResult["source"] = title && description
    ? (suppliedTitle || suppliedDescription ? "supplied" : "none")
    : "none";

  if (!title || !description) {
    // A raw fetch has no copy on a page whose body is injected by a component,
    // and those components can mount late, so the copy comes from a rendered
    // document with a budget long enough for the site's own packet.
    const rendered = input.html ?? (await renderPageText(input.url));
    let text = htmlToText(rendered ?? "");
    if (text.length < 80) {
      return {
        status: "failed",
        route: input.route,
        pageId: current.pageId,
        title: title || null,
        description: description || null,
        source: "none",
        error: "The page copy is too short to describe; deliver the page first, then set its SEO.",
      };
    }
    const generated = await generatePageSeo({
      siteName: input.siteName,
      language: input.language?.trim() || "fr",
      route: input.route,
      pageTitle: input.pageTitle ?? firstHeading(rendered ?? text),
      text,
    });
    title = title || generated.title;
    description = description || generated.description;
    source = "model";
  }

  await setBridgePageSeo(input.alias, input.route, { title, description }, true);

  // The API response is the saved payload, not the page a visitor sees.
  let live = await livePageSeo(input.url);
  if (!live || !sameText(live.title, title) || !sameText(live.description, description)) {
    await new Promise((resolve) => setTimeout(resolve, input.retryDelayMs ?? 8_000));
    live = await livePageSeo(input.url);
  }
  if (!live || !sameText(live.title, title) || !sameText(live.description, description)) {
    return {
      status: "failed",
      route: input.route,
      pageId: current.pageId,
      title,
      description,
      source,
      error: "The page was written but the live document does not serve the new title and description yet.",
    };
  }

  return {
    status: "updated",
    route: input.route,
    pageId: current.pageId,
    title,
    description,
    source,
  };
}
