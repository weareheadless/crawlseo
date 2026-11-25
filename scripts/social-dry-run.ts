/**
 * One social post, end to end, without publishing.
 *
 * planner (DeepSeek) -> editorial (verify) -> Cicero (one design call) -> stop.
 * Nothing reaches the Page: the last step here is the image, and a human decides
 * whether it goes out.
 *
 *   npx tsx scripts/social-dry-run.ts --site <siteId> --tenant <name> \
 *     --photos <dir> [--locale en] [--voice default]
 */

import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { createCiceroClient } from "@/lib/social/cicero";
import { parseSiteBrand, parseSiteRepresentation, readSiteBrand } from "@/lib/site/brand";
import { planPost, type PlannerInput } from "@/lib/social/plan";
import { verifySocialPost, writeSocialCopy } from "@/lib/editorial-service/social";
import { findUnsplashCover } from "@/lib/delivery/unsplash";
import { listSitePages, rankPages, readPage, type SocialTools } from "@/lib/social/tools";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const siteId = arg("site");
const tenant = arg("tenant");
const photoDir = arg("photos");
const locale = arg("locale", "en");
const voice = arg("voice", "default");
// none: stop at the image. draft: upload it unpublished, the human publishes on
// the Page. live: publish now, which is the one step that is public.
const publishMode = arg("publish", "none");
if (!["none", "draft", "live"].includes(publishMode)) {
  console.error("--publish must be none, draft or live");
  process.exit(2);
}

function names(representation: ReturnType<typeof parseSiteRepresentation>): string[] {
  const places = representation.serviceArea.places;
  const entries = representation.entries.flatMap((entry) => [entry.name, ...entry.aliases]);
  return [...new Set([...places, ...entries].filter(Boolean))];
}

/**
 * The photos, with what is in them. A planner handed bare file names picks
 * blind — which is how a rooftop pool ended up illustrating a story about a
 * residential street. A photo with no description is not offered.
 */
function photosCatalog(dir: string): Array<{ file: string; description: string }> {
  const path = `${dir}/photos.json`;
  let entries: Array<{ file: string; description: string; usable?: boolean }> = [];
  try {
    entries = (JSON.parse(readFileSync(path, "utf8")) as { photos?: typeof entries }).photos ?? [];
  } catch {
    throw new Error(`no photo catalogue at ${path}; every photo needs a description before a planner can choose one`);
  }
  return entries
    .filter((entry) => entry.usable !== false && entry.description.trim())
    .map((entry) => ({ file: entry.file, description: entry.description }));
}

async function bundle(): Promise<PlannerInput & { recentCaptions: string[] }> {
  const profile = await readSiteBrand(db, siteId);
  const brand = parseSiteBrand((await db.siteProfile.findUnique({ where: { siteId }, select: { brand: true } }))?.brand);
  const representation = profile?.representation ?? parseSiteRepresentation({ entries: [], serviceArea: {} });
  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true, domain: true } });
  if (!site?.projectId) throw new Error(`site ${siteId} has no project`);

  const since = new Date(Date.now() - 28 * 86400_000);
  const pages = await db.page.groupBy({
    by: ["url"],
    where: { siteId, date: { gte: since } },
    _sum: { clicks: true, impressions: true },
    _avg: { position: true },
    orderBy: { _sum: { impressions: "desc" } },
    take: 40,
  });
  const crawl = pages.map((row) => ({
    url: row.url,
    clicks: row._sum.clicks ?? 0,
    impressions: row._sum.impressions ?? 0,
    position: Number((row._avg.position ?? 0).toFixed(1)),
  }));

  const opportunities = await db.opportunity.findMany({
    where: { projectId: site.projectId, status: { in: ["detected", "accepted", "in_progress", "delivered"] } },
    orderBy: [{ scoreValue: "desc" }, { updatedAt: "desc" }],
    take: 14,
    select: { title: true, summary: true, type: true, status: true, scoreValue: true },
  });

  const findings = await db.researchFinding.findMany({
    where: { run: { projectId: site.projectId } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, runId: true, theme: true, summary: true, confidence: true },
  });
  // One citable source per finding: the newest source its run collected. That is
  // what the planner is allowed to cite, and editorial will hold a claim whose
  // source never existed.
  const runIds = [...new Set(findings.map((row) => row.runId))];
  const citeable = await db.researchSource.findMany({
    where: { runId: { in: runIds } },
    orderBy: { retrievedAt: "desc" },
    select: { runId: true, url: true },
  });
  const firstSource = new Map<string, string>();
  for (const source of citeable) if (!firstSource.has(source.runId)) firstSource.set(source.runId, source.url);

  const posts = await db.socialPost.findMany({
    where: { projectId: site.projectId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { caption: true, publishedAt: true, status: true, opportunityId: true },
  });

  // The pages and photographs the last covers used. Cicero rendered them, so it
  // is the record: the database row only knows what was published, and a draft
  // that a human rejected still used that page and that picture.
  const history = await createCiceroClient({ siteId })
    .history(8)
    .catch(() => []);

  return {
    recentCaptions: history.map((item) => item.caption).filter(Boolean),
    brand: {
      name: brand?.name ?? tenant,
      voiceSample: brand?.voice?.sample ?? "",
      tone: brand?.voice?.tone ?? [],
      services: [],
      topics: [],
      persona: brand?.persona,
    },
    represented: names(representation),
    posts: [
      ...history.map((item) => ({
        subject: item.subject,
        headline: item.onImage[1] ?? item.onImage[0] ?? "",
        publishedAt: item.createdAt || null,
        pageUrl: item.pageUrl,
        // A catalogue photo is recorded as content/<name>; the planner names it
        // by its bare file name, so the two have to compare equal.
        image: (item.assets[0] ?? "").replace(/^content\//, ""),
      })),
      ...posts.map((post) => ({
        subject: "",
        headline: post.caption.slice(0, 120),
        publishedAt: post.publishedAt?.toISOString() ?? null,
      })),
    ],
    opportunities: opportunities.map((row) => ({
      title: row.title,
      summary: row.summary,
      type: String(row.type),
      status: String(row.status),
      score: row.scoreValue,
    })),
    crawl,
    research: findings.map((row) => ({
      theme: row.theme,
      summary: row.summary,
      confidence: row.confidence,
      sourceUrl: firstSource.get(row.runId) ?? "",
    })),
    photos: photosCatalog(photoDir),
    locales: ["en", "es"],
    today: new Date().toISOString().slice(0, 10),
  };
}

async function main() {
  if (!siteId || !tenant || !photoDir) {
    console.error("usage: social-dry-run --site <siteId> --tenant <name> --photos <dir>");
    process.exit(2);
  }

  const input = await bundle();
  console.error(`bundle: ${input.opportunities.length} opportunities, ${input.crawl.length} pages, ` +
    `${input.research.length} findings, ${input.photos.length} photos, ${input.represented.length} represented names`);

  const site = await db.site.findUnique({ where: { id: siteId }, select: { domain: true } });
  const origin = site?.domain ? `https://${site.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : "";
  const tools: SocialTools = {
    readPage: (url) => readPage(url),
    listSitePages: () => listSitePages(origin),
    findPages: async (query) => rankPages(query, await listSitePages(origin)),
    brandPhotos: input.photos,
    searchPhotos: async (query) => {
      const cover = await findUnsplashCover(query, { location: query, siteId });
      return [{ url: cover.url, alt: cover.altText, credit: `Photo: ${cover.photographer} / Unsplash` }];
    },
  };
  const planned = await planPost(input, {
    tools,
    maxSteps: 10,
  });
  if ("error" in planned) {
    console.log(JSON.stringify({ stage: "plan", error: planned.error }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ stage: "plan", ...planned }, null, 2));
  if (!planned.plan.post) return;

  const plan = planned.plan;

  // The words come from the desk that owns the voice, from the decision and the
  // evidence behind it. The planner no longer writes them.
  const brandRecord = await readSiteBrand(db, siteId);
  const brand = brandRecord?.brand;
  // The page is read again for its own words: the writer has to know what the
  // post sends people to, or every caption is written from the angle alone.
  const promoted = await readPage(plan.pageUrl).catch(() => null);
  const written = await writeSocialCopy({
    tenant,
    locale,
    subject: plan.subject,
    angle: plan.angle,
    voice: { tone: brand?.voice.tone, sample: brand?.voice.sample },
    brand: { name: brand?.name, persona: brand?.persona },
    evidence: plan.claims,
    page: {
      url: plan.pageUrl,
      title: promoted?.title ?? "",
      description: promoted?.description ?? "",
    },
    recentCaptions: input.recentCaptions,
  });
  console.log(JSON.stringify({ stage: "copy", ...written }, null, 2));
  if (written.outcome !== "written") return;
  const copy = {
    ...written.copy,
    // The post exists to send a reader to the page. The link is added here, not
    // written by the model, so it is always the page the post was verified against.
    caption: `${written.copy.caption.trim()}\n\n${plan.pageUrl}`,
  };

  const asset = plan.imageUrl
    ? { url: plan.imageUrl, alt: copy.headline, credit: "" }
    : { path: `content/${plan.image}`, alt: copy.headline, credit: "" };
  console.log(JSON.stringify({ stage: "image", chosen: plan.imageUrl || plan.image, note: plan.imageNote }, null, 2));

  const verification = await verifySocialPost({
    tenant,
    locale,
    voice,
    subject: plan.subject,
    page_url: plan.pageUrl,
    angle: plan.angle,
    copy,
    images: [
      {
        name: plan.imageUrl || plan.image,
        alt: asset.alt,
        provenance: "own_photo",
      },
    ],
    representation: "represented",
    claims: plan.claims,
    idempotencyKey: `plan:${siteId}:${input.today}:${plan.imageUrl || plan.image}:${copy.headline.slice(0, 40)}`,
  });
  console.log(JSON.stringify({ stage: "editorial", verification }, null, 2));
  if (verification.state !== "verified") return;

  const artifact = verification.artifact;
  const cicero = createCiceroClient({ siteId });
  const rendered = await cicero.render({
    artifact: {
      id: artifact.id,
      channel: "facebook_page",
      locale,
      page_url: plan.pageUrl,
      subject: plan.subject,
      copy: {
        kicker: artifact.social.kicker,
        headline: artifact.social.headline,
        subline: artifact.social.subline,
        caption: artifact.social.caption,
        facts: artifact.social.facts,
      },
      assets: [
        asset.path
          ? { path: asset.path, alt: asset.alt, credit: asset.credit }
          : { url: asset.url, alt: asset.alt, credit: asset.credit },
      ],
      content_hash: artifact.contentHash,
    },
    artDirection: plan.artDirection,
  });
  console.log(JSON.stringify({ stage: "render", rendered }, null, 2));

  if (publishMode !== "none" && rendered.outcome === "rendered") {
    const published = await cicero.publish({
      renderId: rendered.renderId,
      // One rendered artifact, one publication: a retry of this script returns
      // the first receipt instead of posting the same cover twice.
      idempotencyKey: `plan:${siteId}:${rendered.renderId}`,
      draft: publishMode === "draft",
      caption: rendered.caption,
    });
    console.log(JSON.stringify({ stage: "publish", mode: publishMode, published }, null, 2));
  }
  await db.$disconnect();
}

void main().catch((error: unknown) => {
  console.error(`the run stopped: ${(error as Error).message}`);
  process.exitCode = 1;
});
