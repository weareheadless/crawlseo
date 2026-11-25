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
import { verifySocialPost } from "@/lib/editorial-service/social";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const siteId = arg("site");
const tenant = arg("tenant");
const photoDir = arg("photos");
const locale = arg("locale", "en");
const voice = arg("voice", "default");

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

async function bundle(): Promise<PlannerInput> {
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
    take: 12,
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

  return {
    brand: {
      name: brand?.name ?? tenant,
      voiceSample: brand?.voice?.sample ?? "",
      tone: brand?.voice?.tone ?? [],
      services: [],
      topics: [],
    },
    represented: names(representation),
    posts: posts.map((post) => ({
      subject: "",
      headline: post.caption.slice(0, 120),
      publishedAt: post.publishedAt?.toISOString() ?? null,
    })),
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

  const planned = await planPost(input);
  if ("error" in planned) {
    console.log(JSON.stringify({ stage: "plan", error: planned.error }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ stage: "plan", ...planned }, null, 2));
  if (!planned.plan.post) return;

  const plan = planned.plan;
  const verification = await verifySocialPost({
    tenant,
    locale,
    voice,
    subject: plan.subject,
    angle: plan.angle,
    copy: plan.copy,
    image: { name: plan.image, alt: plan.copy.headline, provenance: "own_photo" },
    representation: "represented",
    claims: plan.claims,
    idempotencyKey: `plan:${siteId}:${input.today}:${plan.image}:${plan.copy.headline.slice(0, 40)}`,
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
      copy: {
        kicker: artifact.social.kicker,
        headline: artifact.social.headline,
        subline: artifact.social.subline,
        caption: artifact.social.caption,
      },
      asset: { path: `content/${artifact.social.image.asset_id}`, alt: artifact.social.image.alt },
      content_hash: artifact.contentHash,
    },
    artDirection: plan.artDirection,
    composition: plan.composition,
  });
  console.log(JSON.stringify({ stage: "render", rendered }, null, 2));
  await db.$disconnect();
}

void main();
