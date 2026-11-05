import { createHash } from "crypto";
import { lookup } from "dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import type { IssueSeverity, IssueType } from "@prisma/client";
import robotsParser from "robots-parser";
import { REMEDIATION } from "./remediation";
import { computeHealthScore } from "./health";
import { auditSchemaSemantics, schemaAuditProjection, type SchemaAuditProjection } from "@/lib/research/crawl-live-check";
import { readBusinessKnowledge } from "@/lib/projects/business-knowledge";
import { persistSchemaSemanticsIssues } from "./schema-semantics-persistence";

const ABSOLUTE_MAX_PAGES = 2000;
const BATCH_SIZE = 2;
const BATCH_DELAY_MS = 1500;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
// Audit what Google can index, not the bot-protection shell. Wix serves
// different HTML to unknown crawlers; the Googlebot-compatible user agent
// receives the prerendered page. Override with CRAWL_USER_AGENT if needed.
const USER_AGENT = process.env.CRAWL_USER_AGENT?.trim()
  || "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

type IssueInput = {
  url: string;
  type: IssueType;
  severity: IssueSeverity;
  message: string;
  details?: Record<string, unknown>;
};

type LinkInfo = {
  sourceUrl: string;
  targetUrl: string;
  anchorText: string | null;
  isInternal: boolean;
  isNofollow: boolean;
  statusCode: number | null;
};

type PageSnapshot = {
  url: string;
  statusCode: number;
  redirectUrl: string | null;
  title: string | null;
  description: string | null;
  h1s: string[];
  canonical: string | null;
  robotsMeta: string | null;
  wordCount: number;
  contentScore: number;
  internalOutlinks: string[];
  externalOutlinks: string[];
  links: LinkInfo[];
  hasSchema: boolean;
  hreflangTags: { lang: string; href: string }[];
  imageCount: number;
  imagesMissingAlt: number;
  bytes: number;
  loadMs: number;
  contentHash: string;
  /** Extracted body text, so coverage claims can be checked against content. */
  contentText: string;
  indexable: boolean;
};

/* ------------------------------------------------------------------ */
/*  URL helpers                                                       */
/* ------------------------------------------------------------------ */

function normalizeUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Canonical form used to compare a crawled URL with a sitemap entry. Two URLs
 * that address the same page must produce the same key even when one side is
 * `www`, has a trailing slash, or is percent-encoded differently.
 */
export function sitemapKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = u.pathname.length > 1 && u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      // Malformed escape: keep the raw pathname.
    }
    return `${host}${decoded}${u.search}`;
  } catch {
    return raw;
  }
}

function sameHost(a: string, b: string): boolean {
  try {
    return (
      new URL(a).hostname.replace(/^www\./, "") ===
      new URL(b).hostname.replace(/^www\./, "")
    );
  } catch {
    return false;
  }
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

/* ------------------------------------------------------------------ */
/*  SSRF protection                                                   */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function ipv4InRange(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function ipv6ToBigInt(input: string): bigint | null {
  let ip = input.trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (isIP(ip) !== 6) return null;

  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (group.includes(".")) {
        const v4 = ipv4ToInt(group);
        if (v4 == null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  return groups.reduce((value, group) => (value << BigInt(16)) | BigInt(group), BigInt(0));
}

function ipv6InRange(value: bigint, base: string, bits: number): boolean {
  const baseValue = ipv6ToBigInt(base);
  if (baseValue == null) return false;
  const shift = BigInt(128 - bits);
  return (value >> shift) === (baseValue >> shift);
}

/**
 * True only for addresses that are safe to contact.
 *
 * This is an allow-list in effect: every non-public, reserved, documentation,
 * benchmarking, multicast and shared address range is refused, including the
 * carrier-grade NAT range 100.64.0.0/10 that the previous classifier missed.
 * IPv4-mapped IPv6 addresses are unwrapped and classified as IPv4.
 */
export function isPublicAddress(input: string): boolean {
  const ip = input.trim();
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    if (value == null) return false;
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, bits]) => ipv4InRange(value, base, bits));
  }
  if (family === 6) {
    const value = ipv6ToBigInt(ip);
    if (value == null) return false;
    if (ipv6InRange(value, "::ffff:0.0.0.0", 96)) {
      const low = Number(value & BigInt(0xffffffff));
      return isPublicAddress(`${(low >>> 24) & 255}.${(low >>> 16) & 255}.${(low >>> 8) & 255}.${low & 255}`);
    }
    const blocked: Array<[string, number]> = [
      ["::", 128],
      ["::1", 128],
      ["fc00::", 7],
      ["fe80::", 10],
      ["ff00::", 8],
      ["100::", 64],
      ["2001:2::", 48],
      ["2001:10::", 28],
      ["2001:20::", 28],
      ["2001:db8::", 32],
    ];
    return !blocked.some(([base, bits]) => ipv6InRange(value, base, bits));
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  return !isPublicAddress(ip);
}

async function assertPublicUrl(url: string): Promise<void> {
  const { hostname } = new URL(url);
  const { address } = await lookup(hostname);
  if (isPrivateIp(address)) {
    throw new Error(`Blocked: ${hostname} resolves to private/reserved IP`);
  }
}

/**
 * Validates that a domain string resolves to a public IP.
 * Used at site-creation time to reject private/reserved targets.
 */
export async function assertPublicDomain(domain: string): Promise<void> {
  const url = domain.startsWith("http") ? domain : `https://${domain}`;
  await assertPublicUrl(url);
}

/* ------------------------------------------------------------------ */
/*  HTML parsing helpers                                              */
/* ------------------------------------------------------------------ */

function extractTag(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m?.[1]?.trim() || null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * HTML with executable and template regions removed.
 *
 * `<script>` bodies are JavaScript, not markup: they contain string literals such
 * as `` `<a href="${esc(url)}">` ``. Scanning raw HTML for anchors read those
 * templates as real links and reported a 404 on `/cities/${esc(url)}` — a page the
 * site never links to. Templates and `<noscript>` are excluded for the same
 * reason: their content is not the page's navigation.
 */
export function documentMarkup(html: string): string {
  let markup = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["script", "style", "template", "noscript"]) {
    // A terminated region is removed whole; an unterminated one would otherwise
    // leave its body in the markup and reintroduce the same false links.
    markup = markup
      .replace(new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*?<\\/" + tag + "\\s*>", "gi"), " ")
      .replace(new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*$", "gi"), " ");
  }
  return markup;
}

/* ------------------------------------------------------------------ */
/*  Parse a fetched HTML page into a snapshot                         */
/* ------------------------------------------------------------------ */

function parseHtml(
  url: string,
  html: string,
  statusCode: number,
  loadMs: number,
  bytes: number,
  redirectUrl: string | null,
  seedUrl: string
): PageSnapshot {
  const titleRaw = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleRaw
    ? decodeEntities(titleRaw.replace(/\s+/g, " ").trim())
    : null;

  const description =
    extractTag(
      html,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
    ) ||
    extractTag(
      html,
      /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i
    );

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
    decodeEntities(stripTags(m[1])).slice(0, 200)
  );

  const canonical =
    extractTag(
      html,
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
    ) ||
    extractTag(
      html,
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i
    );

  // robots meta
  const robotsMeta =
    extractTag(
      html,
      /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i
    ) ||
    extractTag(
      html,
      /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']robots["']/i
    );

  const hasSchema =
    /application\/ld\+json/i.test(html) ||
    /\bitemscope\b/i.test(html) ||
    /\bitemtype\b/i.test(html);

  // hreflang tags
  const hreflangTags = [
    ...html.matchAll(
      /<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["'][^>]+href=["']([^"']+)["'][^>]*>/gi
    ),
    ...html.matchAll(
      /<link[^>]+href=["']([^"']+)["'][^>]+hreflang=["']([^"']+)["'][^>]+rel=["']alternate["'][^>]*>/gi
    ),
  ].map((m) => {
    // The capture groups might be in different order depending on which regex matched
    // First regex: hreflang is group 1, href is group 2
    // Second regex: href is group 1, hreflang is group 2
    if (m[0].indexOf("hreflang") < m[0].indexOf("href=")) {
      return { lang: m[1], href: m[2] };
    }
    return { lang: m[2], href: m[1] };
  });

  // Images
  const imgTags = [...documentMarkup(html).matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imageCount = imgTags.length;
  const imagesMissingAlt = imgTags.filter(
    (tag) => !/\balt\s*=\s*["'][^"']+["']/i.test(tag)
  ).length;

  // Body text and word count
  const bodyText = stripTags(documentMarkup(html));
  const words = bodyText ? bodyText.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;

  // Content hash
  const contentHash = hashText(bodyText);

  // Links - extract anchor text, nofollow, internal/external
  const internalOutlinks: string[] = [];
  const externalOutlinks: string[] = [];
  const links: LinkInfo[] = [];

  const anchorMatches = [
    ...documentMarkup(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi),
  ];
  for (const m of anchorMatches) {
    const attrs = m[1];
    const anchorContent = m[2];
    const hrefMatch = attrs.match(/href=["']([^"'#][^"']*)["']/i);
    if (!hrefMatch) continue;

    const abs = normalizeUrl(hrefMatch[1], url);
    if (!abs) continue;

    const anchorText = decodeEntities(stripTags(anchorContent)).slice(0, 200) || null;
    const isNofollow = /\brel=["'][^"']*nofollow[^"']*["']/i.test(attrs);
    const isInternal = sameHost(abs, seedUrl);

    links.push({
      sourceUrl: url,
      targetUrl: abs,
      anchorText,
      isInternal,
      isNofollow,
      statusCode: null, // filled in later for internal links
    });

    if (isInternal) {
      internalOutlinks.push(abs);
    } else {
      externalOutlinks.push(abs);
    }
  }

  // Indexable: not blocked by robots meta
  const indexable = !(
    robotsMeta &&
    (/noindex/i.test(robotsMeta))
  );

  // Simple on-page content score 0-100
  let contentScore = 40;
  if (title && title.length >= 15 && title.length <= 65) contentScore += 15;
  else if (title) contentScore += 5;
  if (description && description.length >= 50 && description.length <= 160)
    contentScore += 15;
  else if (description) contentScore += 5;
  if (h1s.length === 1) contentScore += 15;
  else if (h1s.length > 1) contentScore += 5;
  if (wordCount >= 300) contentScore += 15;
  else if (wordCount >= 100) contentScore += 8;
  if (hasSchema) contentScore += 5;
  if (canonical) contentScore += 5;
  contentScore = Math.max(0, Math.min(100, contentScore));

  return {
    url,
    statusCode,
    redirectUrl,
    title,
    description,
    h1s,
    canonical: canonical ? normalizeUrl(canonical, url) : null,
    robotsMeta,
    wordCount,
    contentScore,
    internalOutlinks: [...new Set(internalOutlinks)],
    externalOutlinks: [...new Set(externalOutlinks)],
    links,
    hasSchema,
    hreflangTags,
    imageCount,
    imagesMissingAlt,
    bytes,
    loadMs,
    contentHash,
    contentText: bodyText.slice(0, 20_000),
    indexable,
  };
}

/* ------------------------------------------------------------------ */
/*  Fetch helpers                                                     */
/* ------------------------------------------------------------------ */

async function readBodyCapped(res: Response): Promise<ArrayBuffer> {
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buf.buffer;
}

export type PublicDocument = {
  statusCode: number;
  html: string;
  finalUrl: string;
  bytes: number;
  contentType: string;
  /** True when the body exceeded the configured byte limit. */
  truncated: boolean;
};

export type ResolvedAddress = { address: string; family: number };

export type PublicDocumentTransport = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; address: string; family: number }
) => Promise<Response>;

export type PublicDocumentOptions = {
  /** Exact byte allowance. Zero or negative means no dispatch at all. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Absolute epoch-millisecond deadline shared with the caller's budget. */
  deadlineAt?: number;
  maxRedirects?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  /** Authorised-origin policy, checked on every hop before dispatch. */
  allowedHost?: (url: URL) => boolean;
  /** Called before every network hop; throw to stop before dispatch. */
  beforeHop?: (url: string) => void | Promise<void>;
  /** Called with every byte actually read, including partial and aborted reads. */
  onBytes?: (bytes: number) => void;
  /** Test seam: resolve a hostname without real DNS. */
  resolve?: (hostname: string) => Promise<string | ResolvedAddress | ResolvedAddress[]>;
  /** Test seam: perform the pinned request without a real socket. */
  transport?: PublicDocumentTransport;
};

function assertSafeUrlShape(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked: unsupported protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Blocked: credentials in URL");
  }
  const port = url.port;
  if (port && port !== "80" && port !== "443") {
    throw new Error(`Blocked: non-standard port ${port}`);
  }
}

async function withDeadline<T>(promise: Promise<T>, deadlineAt: number, message: string): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error(message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normaliseResolved(value: string | ResolvedAddress | ResolvedAddress[]): ResolvedAddress[] {
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((row) => {
    if (typeof row === "string") return { address: row, family: isIP(row) || 4 };
    return row;
  });
}

/**
 * A connection whose DNS answer is pinned to the address already validated.
 *
 * Passing the validated address into `lookup` removes the DNS-rebinding window
 * between the safety check and the socket connection.
 */
function pinnedTransport(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; address: string; family: number }
): Promise<Response> {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: init.headers,
        signal: init.signal,
        servername: target.hostname,
        lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
          callback(null, init.address, init.family);
        }) as never,
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(", "));
        }
        const body = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status: response.statusCode ?? 0, headers }));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

/**
 * Bounded public-document retrieval with manual redirects.
 *
 * Every hop is shape-checked, origin-checked, fully resolved and validated before
 * it is dispatched, so a redirect cannot make the process contact an unauthorised
 * or private destination. The validated address is pinned to the connection. The
 * body is streamed against the exact remaining byte allowance, charged as it is
 * read, and returned with an explicit truncation flag.
 */
export async function fetchPublicDocument(
  input: string,
  opts: PublicDocumentOptions = {}
): Promise<PublicDocument> {
  const requestedMax = opts.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isFinite(requestedMax) || requestedMax <= 0) {
    throw new Error("Blocked: no byte allowance remains");
  }
  const maxBytes = Math.min(Math.floor(requestedMax), MAX_RESPONSE_BYTES);
  const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? FETCH_TIMEOUT_MS, 60_000));
  const maxRedirects = Math.max(0, Math.min(opts.maxRedirects ?? MAX_REDIRECTS, 10));
  const deadlineAt = Math.min(Date.now() + timeoutMs, opts.deadlineAt ?? Number.POSITIVE_INFINITY);
  if (deadlineAt <= Date.now()) {
    throw new Error("Blocked: deadline exceeded before dispatch");
  }
  const resolveHost = opts.resolve ?? (async (hostname: string) => lookup(hostname, { all: true }));
  const transport = opts.transport ?? pinnedTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
  try {
    let currentUrl = input;
    let response: Response | null = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (Date.now() >= deadlineAt) throw new Error("Blocked: deadline exceeded before dispatch");
      const parsed = new URL(currentUrl);
      assertSafeUrlShape(parsed);
      if (opts.allowedHost && !opts.allowedHost(parsed)) {
        throw new Error(`Blocked: ${parsed.host} is outside the authorised origin`);
      }
      const addresses = normaliseResolved(
        await withDeadline(resolveHost(parsed.hostname), deadlineAt, "Blocked: deadline exceeded during DNS resolution")
      );
      if (addresses.length === 0) throw new Error(`Blocked: ${parsed.hostname} did not resolve`);
      for (const entry of addresses) {
        if (!isPublicAddress(entry.address)) {
          throw new Error(`Blocked: ${parsed.hostname} resolves to private/reserved IP (${entry.address})`);
        }
      }
      const address = addresses[0];
      await opts.beforeHop?.(currentUrl);
      response = await transport(currentUrl, {
        headers: {
          "User-Agent": opts.userAgent ?? USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          ...(opts.headers ?? {}),
        },
        signal: controller.signal,
        address: address.address,
        family: address.family,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        currentUrl = new URL(location, currentUrl).toString();
        if (hop === maxRedirects) {
          throw new Error(`Too many redirects (>${maxRedirects})`);
        }
        continue;
      }
      break;
    }
    if (!response) throw new Error("No response");

    const contentType = response.headers.get("content-type") || "";
    let bytes = 0;
    let truncated = false;
    const chunks: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - bytes;
        if (value.byteLength > remaining) {
          const take = Math.max(0, remaining);
          if (take > 0) {
            chunks.push(value.slice(0, take));
            bytes += take;
            opts.onBytes?.(take);
          }
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        bytes += value.byteLength;
        opts.onBytes?.(value.byteLength);
        if (bytes >= maxBytes) {
          // One extra read distinguishes an exact-size body from a capped one.
          const next = await reader.read();
          if (!next.done) {
            truncated = true;
            await reader.cancel();
          }
          break;
        }
      }
    }
    const buf = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const html =
      contentType.includes("html") || contentType.includes("xml")
        ? new TextDecoder("utf-8", { fatal: false }).decode(buf)
        : "";
    return {
      statusCode: response.status,
      html,
      finalUrl: currentUrl,
      bytes,
      contentType,
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(url: string): Promise<{
  statusCode: number;
  html: string;
  finalUrl: string;
  loadMs: number;
  bytes: number;
  contentType: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    let currentUrl = url;
    let res: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(currentUrl);
      res = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) break;
        currentUrl = new URL(location, currentUrl).toString();
        if (hop === MAX_REDIRECTS - 1) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
        }
        continue;
      }
      break;
    }

    if (!res) throw new Error("No response");

    const buf = await readBodyCapped(res);
    const bytes = buf.byteLength;
    const contentType = res.headers.get("content-type") || "";
    const html =
      contentType.includes("html") || contentType.includes("xml")
        ? new TextDecoder("utf-8", { fatal: false }).decode(buf)
        : "";
    return {
      statusCode: res.status,
      html,
      finalUrl: currentUrl,
      loadMs: Date.now() - started,
      bytes,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPageWithRetry(url: string): Promise<Awaited<ReturnType<typeof fetchPage>>> {
  let last: Awaited<ReturnType<typeof fetchPage>> | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    last = await fetchPage(url);
    if (last.statusCode !== 429) return last;
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 3_000 * 2 ** attempt));
    }
  }
  return last!;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    await assertPublicUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      if (!res.ok) return null;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function parseSitemapUrls(xml: string, base: string): string[] {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) =>
    m[1].trim()
  );
  const out: string[] = [];
  for (const loc of locs) {
    const n = normalizeUrl(loc, base);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Resource bounds, not site rules. A sitemap index can nest arbitrarily deep
 * (index -> index -> urlset) and can list thousands of documents; the crawl
 * only needs enough URLs to seed a crawl, so it stops on volume rather than on
 * a fixed number of children.
 */
const SITEMAP_DOCUMENT_BUDGET = 50;
const SITEMAP_URL_BUDGET = 10_000;

/**
 * Read every sitemap the site advertises, following sitemap indexes to their
 * children. `robots.txt` may name several sitemaps, so all `Sitemap:` lines are
 * used, not just the first. No CMS is assumed: Wix, Shopify, WordPress and a
 * hand-written sitemap all look the same to this reader.
 */
export async function collectSitemapUrls(
  fetchText: (url: string) => Promise<string | null>,
  origin: string,
  robotsText: string | null
): Promise<string[]> {
  const queue: string[] = [];
  if (robotsText) {
    for (const match of robotsText.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)) {
      const url = normalizeUrl(match[1], origin);
      if (url) queue.push(url);
    }
  }
  queue.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  const visited = new Set<string>();
  const urls: string[] = [];
  while (queue.length > 0 && visited.size < SITEMAP_DOCUMENT_BUDGET && urls.length < SITEMAP_URL_BUDGET) {
    const document = queue.shift() as string;
    if (visited.has(document)) continue;
    visited.add(document);
    const xml = await fetchText(document);
    if (!xml) continue;
    if (/<sitemapindex[\s>]/i.test(xml)) {
      for (const child of parseSitemapUrls(xml, origin)) {
        if (!visited.has(child)) queue.push(child);
      }
      continue;
    }
    urls.push(...parseSitemapUrls(xml, origin));
    if (urls.length >= SITEMAP_URL_BUDGET) break;
  }
  return urls.slice(0, SITEMAP_URL_BUDGET);
}

/* ------------------------------------------------------------------ */
/*  Issue detection per page                                          */
/* ------------------------------------------------------------------ */

function issuesFromPage(page: PageSnapshot): IssueInput[] {
  const issues: IssueInput[] = [];
  const { url } = page;

  const rem = (type: string) => {
    const r = REMEDIATION[type];
    return r ? { howToFix: r.howToFix } : {};
  };

  if (page.statusCode >= 400) {
    issues.push({
      url,
      type: "BROKEN_LINK",
      severity: "CRITICAL",
      message: `HTTP ${page.statusCode}`,
      details: { statusCode: page.statusCode, ...rem("BROKEN_LINK") },
    });
    return issues;
  }

  if (!page.title) {
    issues.push({
      url,
      type: "MISSING_TITLE",
      severity: "CRITICAL",
      message: "Missing <title> tag",
      details: rem("MISSING_TITLE"),
    });
  }

  if (!page.description) {
    issues.push({
      url,
      type: "MISSING_DESCRIPTION",
      severity: "WARNING",
      message: "Missing meta description",
      details: rem("MISSING_DESCRIPTION"),
    });
  }

  if (page.h1s.length === 0) {
    issues.push({
      url,
      type: "MISSING_H1",
      severity: "WARNING",
      message: "No H1 heading found",
      details: rem("MISSING_H1"),
    });
  } else if (page.h1s.length > 1) {
    issues.push({
      url,
      type: "MULTIPLE_H1",
      severity: "INFO",
      message: `${page.h1s.length} H1 headings found`,
      details: { h1s: page.h1s, ...rem("MULTIPLE_H1") },
    });
  }

  if (page.imagesMissingAlt > 0) {
    issues.push({
      url,
      type: "MISSING_ALT",
      severity: "WARNING",
      message: `${page.imagesMissingAlt}/${page.imageCount} images missing alt`,
      details: {
        missing: page.imagesMissingAlt,
        total: page.imageCount,
        ...rem("MISSING_ALT"),
      },
    });
  }

  if (!page.canonical) {
    issues.push({
      url,
      type: "MISSING_CANONICAL",
      severity: "INFO",
      message: "No canonical tag",
      details: rem("MISSING_CANONICAL"),
    });
  }

  if (!page.hasSchema) {
    issues.push({
      url,
      type: "MISSING_SCHEMA",
      severity: "INFO",
      message: "No structured data (JSON-LD / microdata)",
      details: { ...rem("MISSING_SCHEMA"), kind: "identity_jsonld_absence" },
    });
  }

  if (page.loadMs > 3000) {
    issues.push({
      url,
      type: "SLOW_PAGE",
      severity: "WARNING",
      message: `Slow response: ${page.loadMs}ms`,
      details: { loadMs: page.loadMs, ...rem("SLOW_PAGE") },
    });
  }

  if (page.bytes > 3 * 1024 * 1024) {
    issues.push({
      url,
      type: "LARGE_PAGE",
      severity: "WARNING",
      message: `Large HTML payload: ${(page.bytes / 1024 / 1024).toFixed(1)}MB`,
      details: { bytes: page.bytes, ...rem("LARGE_PAGE") },
    });
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/*  Main crawl result type                                            */
/* ------------------------------------------------------------------ */

export type CrawlResult = {
  crawlId: string;
  pagesFound: number;
  issuesFound: number;
  healthScore: number;
  sitemapUrls: number;
  missingFromSitemap: number;
  orphanCandidates: number;
  avgContentScore: number;
};

/* ------------------------------------------------------------------ */
/*  Main crawl function                                               */
/* ------------------------------------------------------------------ */

/**
 * Crawl a site starting from domain root (+ sitemap).
 * Supports up to 2000 pages with concurrent batch fetching.
 */
export async function runSiteCrawl(
  siteId: string,
  domain: string,
  maxPages: number = 200,
  existingCrawlId?: string
): Promise<CrawlResult> {
  const effectiveMax = Math.max(1, Math.min(maxPages, ABSOLUTE_MAX_PAGES));
  const seed = domain.startsWith("http") ? domain : `https://${domain}`;
  const seedUrl = normalizeUrl(seed, seed) || seed;
  const origin = originOf(seedUrl);

  const crawl = existingCrawlId
    ? await db.crawl.update({
        where: { id: existingCrawlId },
        data: { status: "RUNNING", startedAt: new Date() },
      })
    : await db.crawl.create({
        data: {
          siteId,
          status: "RUNNING",
          startedAt: new Date(),
        },
      });

  // Crawl the pages that earn the traffic first. Sitemap order is not demand
  // order: on atelier-harmonie the sitemap lists /en/ variants that carry almost
  // no impressions while /lampes, /shop and the product pages carry most of them.
  const priorityUrls = await topTrafficUrls(siteId, effectiveMax);
  try {
    return await executeCrawl(crawl.id, siteId, seedUrl, origin, effectiveMax, priorityUrls);
  } catch (err) {
    // Mark crawl as failed on any unhandled error
    await db.crawl
      .update({
        where: { id: crawl.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
        },
      })
      .catch(() => {}); // swallow DB errors during cleanup
    throw err;
  }
}

/** Top Search Console pages by impressions over the last 28 days. */
async function topTrafficUrls(siteId: string, limit: number): Promise<string[]> {
  try {
    const since = new Date(Date.now() - 28 * 864e5);
    const rows = await db.page.groupBy({
      by: ["url"],
      where: { siteId, date: { gte: since }, impressions: { gt: 0 } },
      _sum: { impressions: true },
      orderBy: { _sum: { impressions: "desc" } },
      take: Math.max(limit, 20),
    });
    return rows.map((row) => row.url).filter((url): url is string => Boolean(url));
  } catch {
    return [];
  }
}

async function executeCrawl(
  crawlId: string,
  siteId: string,
  seedUrl: string,
  origin: string,
  maxPages: number,
  priorityUrls: string[] = []
): Promise<CrawlResult> {
  const issues: IssueInput[] = [];
  const pages: PageSnapshot[] = [];
  const auditPages: Array<{ url: string; projection: SchemaAuditProjection | null }> = [];
  const allLinks: LinkInfo[] = [];
  const visited = new Set<string>();
  const queue: string[] = [seedUrl];

  /* ---- robots.txt ---- */
  const robotsUrl = `${origin}/robots.txt`;
  const robotsText = await fetchText(robotsUrl);

  let robotsChecker: ReturnType<typeof robotsParser> | null = null;
  if (!robotsText) {
    issues.push({
      url: robotsUrl,
      type: "MISSING_ROBOTS",
      severity: "WARNING",
      message: "robots.txt not found or unreachable",
      details: REMEDIATION.MISSING_ROBOTS
        ? { howToFix: REMEDIATION.MISSING_ROBOTS.howToFix }
        : {},
    });
  } else {
    robotsChecker = robotsParser(robotsUrl, robotsText);
    for (const crawler of ["GPTBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended"]) {
      const lines = robotsText.split(/\r?\n/);
      const rule = lines.find((line) => /^\s*Disallow\s*:/i.test(line) && robotsParser(robotsUrl, `${line}\n`).isAllowed(`${origin}/`, crawler) === false);
      if (rule && robotsChecker.isAllowed(`${origin}/`, crawler) === false) {
        issues.push({ url: robotsUrl, type: "MISSING_SCHEMA", severity: "WARNING", message: `${crawler} is blocked by robots rule: ${rule.trim()}`,
          details: { kind: "ai_crawler_block", crawler, rule: rule.trim(), gapIdentity: `robots:${crawler}:${rule.trim()}` } });
      }
    }
  }

  /* ---- Sitemap discovery ---- */
  const sitemapUrls = [
    ...new Set((await collectSitemapUrls(fetchText, origin, robotsText)).filter((u) => sameHost(u, seedUrl))),
  ];
  if (sitemapUrls.length === 0) {
    issues.push({
      url: `${origin}/sitemap.xml`,
      type: "MISSING_SITEMAP",
      severity: "WARNING",
      message: "No sitemap.xml found",
      details: REMEDIATION.MISSING_SITEMAP
        ? { howToFix: REMEDIATION.MISSING_SITEMAP.howToFix }
        : {},
    });
  } else {
    // Sitemap order is not demand order: sort the URLs we know earn impressions
    // to the front, then the rest of the sitemap.
    const priorityRank = new Map<string, number>();
    for (const [index, url] of priorityUrls.entries()) {
      const normalized = normalizeUrl(url, url);
      if (normalized) priorityRank.set(normalized, index);
    }
    sitemapUrls.sort((a, b) => {
      const ra = priorityRank.get(normalizeUrl(a, origin) ?? a) ?? Number.POSITIVE_INFINITY;
      const rb = priorityRank.get(normalizeUrl(b, origin) ?? b) ?? Number.POSITIVE_INFINITY;
      return ra - rb;
    });
    for (const u of sitemapUrls.slice(0, 100)) {
      if (!queue.includes(u)) queue.push(u);
    }
  }

  // Traffic pages the sitemap omits (or lists too late) still get crawled, in
  // demand order.
  const priorityQueue = priorityUrls
    .map((url) => normalizeUrl(url, origin))
    .filter((url): url is string => Boolean(url) && !queue.includes(url!));
  if (priorityQueue.length > 0) queue.unshift(...priorityQueue);

  /* ---- Crawl loop with batch concurrency ---- */
  let rateLimitedResponses = 0;
  while (queue.length > 0 && pages.length < maxPages) {
    // Collect the next batch of unvisited URLs
    const batch: string[] = [];
    while (batch.length < BATCH_SIZE && queue.length > 0 && pages.length + batch.length < maxPages) {
      const next = queue.shift()!;
      const normalized = normalizeUrl(next, origin);
      if (!normalized || visited.has(normalized)) continue;
      if (!sameHost(normalized, seedUrl)) continue;

      // Check robots.txt. isAllowed() returns `undefined` (not `false`) when
      // the URL's host differs from the one robots.txt was fetched from —
      // e.g. an apex domain that redirects to www. sameHost() above already
      // confirms it's the same site, so only an explicit `false` (a real
      // Disallow match) should block the crawl here.
      if (robotsChecker && robotsChecker.isAllowed(normalized, USER_AGENT) === false) {
        visited.add(normalized);
        continue;
      }

      visited.add(normalized);
      batch.push(normalized);
    }

    if (batch.length === 0) break;

    // Fetch all pages in the batch concurrently
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const res = await fetchPageWithRetry(url);
          return { url, res, error: null };
        } catch (err) {
          return { url, res: null, error: err };
        }
      })
    );

    for (const result of results) {
      if (result.status === "rejected") continue;
      const { url, res, error } = result.value;
      if (res?.statusCode === 429) rateLimitedResponses += 1;

      if (error || !res) {
        auditPages.push({ url, projection: null });
        issues.push({
          url,
          type: "BROKEN_LINK",
          severity: "CRITICAL",
          message:
            error instanceof Error ? error.message : "Fetch failed",
          details: { howToFix: REMEDIATION.BROKEN_LINK?.howToFix },
        });
        continue;
      }

      if (!res.contentType.includes("html") && res.statusCode < 400) {
        auditPages.push({ url, projection: null });
        continue;
      }

      const finalNormalized = normalizeUrl(res.finalUrl, origin) || url;
      const redirectUrl =
        finalNormalized !== url ? finalNormalized : null;

      // A redirect can resolve to a URL that's also seeded from the sitemap or
      // linked elsewhere. Only the requested URL was marked visited, so without
      // this the resolved page gets fetched and stored twice — inflating page
      // counts and producing phantom DUPLICATE_TITLE/DESCRIPTION issues.
      if (redirectUrl) {
        if (visited.has(finalNormalized)) continue;
        visited.add(finalNormalized);
      }

      const auditProjection = res.contentType.includes("html") ? schemaAuditProjection(res.html) : null;
      auditPages.push({ url: finalNormalized, projection: auditProjection });

      const page = parseHtml(
        finalNormalized,
        res.html,
        res.statusCode,
        res.loadMs,
        res.bytes,
        redirectUrl,
        seedUrl
      );

      // Mixed content check on raw HTML
      if (
        page.url.startsWith("https://") &&
        /(?:src|href)=["']http:\/\//i.test(res.html)
      ) {
        issues.push({
          url: page.url,
          type: "MIXED_CONTENT",
          severity: "WARNING",
          message: "Page loads insecure HTTP resources",
          details: { howToFix: REMEDIATION.MIXED_CONTENT?.howToFix },
        });
      }

      pages.push(page);
      allLinks.push(...page.links);
      issues.push(...issuesFromPage(page));

      // Enqueue discovered internal links
      for (const link of page.internalOutlinks) {
        if (!visited.has(link)) {
          queue.push(link);
        }
      }
    }

    // A site that throttles a minority of pages is still worth auditing: throwing
    // away 50 good pages because 6 were 429 is how atelier-harmonie ended up with
    // a one-page crawl. Abort only when nothing usable came back; otherwise slow
    // down, and stop adding pages if throttling dominates.
    if (pages.length === 0 && rateLimitedResponses > 0) {
      throw new Error("Site rate-limited the crawler (HTTP 429) before any usable page was audited. The crawl was aborted; retry later.");
    }
    const throttledShare = rateLimitedResponses / (pages.length + rateLimitedResponses);
    if (pages.length > 0 && throttledShare > 0.5) break;

    // Small delay between batches to avoid hammering the target; longer when the
    // site is already throttling.
    if (queue.length > 0 && pages.length < maxPages) {
      const delay = throttledShare > 0.1 ? Math.max(BATCH_DELAY_MS, 5_000) : BATCH_DELAY_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /* ---- Duplicate titles / descriptions ---- */
  // Error/rate-limit pages all share the same challenge title. They are not
  // real duplicate content and must never become editorial work.
  const successfulPages = pages.filter((p) => p.statusCode < 400);
  const byTitle = new Map<string, string[]>();
  const byDesc = new Map<string, string[]>();
  for (const p of successfulPages) {
    if (p.title) {
      const list = byTitle.get(p.title) || [];
      list.push(p.url);
      byTitle.set(p.title, list);
    }
    if (p.description) {
      const list = byDesc.get(p.description) || [];
      list.push(p.url);
      byDesc.set(p.description, list);
    }
  }
  for (const [title, urls] of byTitle) {
    if (urls.length > 1) {
      for (const url of urls) {
        issues.push({
          url,
          type: "DUPLICATE_TITLE",
          severity: "WARNING",
          message: `Duplicate title shared by ${urls.length} pages`,
          details: {
            title,
            urls,
            howToFix: REMEDIATION.DUPLICATE_TITLE?.howToFix,
          },
        });
      }
    }
  }
  for (const [description, urls] of byDesc) {
    if (urls.length > 1) {
      for (const url of urls) {
        issues.push({
          url,
          type: "DUPLICATE_DESCRIPTION",
          severity: "INFO",
          message: `Duplicate meta description on ${urls.length} pages`,
          details: {
            description,
            urls,
            howToFix: REMEDIATION.DUPLICATE_DESCRIPTION?.howToFix,
          },
        });
      }
    }
  }

  /* ---- Sitemap coverage & orphan detection ---- */
  // Compare canonical forms: the same page can appear as `www`/apex, with a
  // trailing slash, or percent-encoded on one side only. An exact string match
  // turns those differences into a false "not in sitemap" finding.
  const crawledSet = new Map(successfulPages.map((p) => [sitemapKey(p.url), p.url]));
  const sitemapSet = new Set(sitemapUrls.map(sitemapKey));
  const missingFromSitemap = [...crawledSet.entries()]
    .filter(([key]) => sitemapSet.size > 0 && !sitemapSet.has(key))
    .map(([, url]) => url);

  const inlinkCount = new Map<string, number>();
  for (const p of successfulPages) {
    for (const out of p.internalOutlinks) {
      inlinkCount.set(out, (inlinkCount.get(out) || 0) + 1);
    }
  }
  const orphans = successfulPages.filter((p) => {
    const isHome = new URL(p.url).pathname === "/" || p.url === seedUrl;
    return !isHome && (inlinkCount.get(p.url) || 0) === 0;
  });

  for (const url of missingFromSitemap) {
    issues.push({
      url,
      type: "MISSING_SITEMAP",
      severity: "INFO",
      message: "Crawled page not listed in sitemap",
      details: {
        kind: "not_in_sitemap",
        howToFix: REMEDIATION.MISSING_SITEMAP?.howToFix,
      },
    });
  }

  for (const p of orphans.slice(0, 50)) {
    issues.push({
      url: p.url,
      type: "MISSING_CANONICAL",
      severity: "WARNING",
      message: "Potential orphan page (no internal inlinks found)",
      details: { kind: "orphan", contentScore: p.contentScore },
    });
  }

  /* ---- Compute scores ---- */
  const healthScore = computeHealthScore(issues, pages.length);
  const avgContentScore =
    successfulPages.length > 0
      ? Math.round(
          successfulPages.reduce((s, p) => s + p.contentScore, 0) / successfulPages.length
        )
      : 0;

  /* ---- Persist AuditPage records ---- */
  if (pages.length > 0) {
    // Batch in chunks to avoid overly large createMany calls
    const PAGE_BATCH = 100;
    for (let i = 0; i < pages.length; i += PAGE_BATCH) {
      const chunk = pages.slice(i, i + PAGE_BATCH);
      await db.auditPage.createMany({
        data: chunk.map((p) => ({
          crawlId,
          url: p.url,
          statusCode: p.statusCode,
          redirectUrl: p.redirectUrl,
          title: p.title,
          description: p.description,
          canonical: p.canonical,
          robotsMeta: p.robotsMeta,
          h1Count: p.h1s.length,
          h1s: p.h1s,
          wordCount: p.wordCount,
          imageCount: p.imageCount,
          imagesMissingAlt: p.imagesMissingAlt,
          internalLinks: p.internalOutlinks.length,
          externalLinks: p.externalOutlinks.length,
          hasSchema: p.hasSchema,
          hreflangTags: p.hreflangTags.length > 0 ? p.hreflangTags : undefined,
          contentScore: p.contentScore,
          contentHash: p.contentHash,
          contentText: p.contentText,
          responseTimeMs: p.loadMs,
          byteSize: p.bytes,
          indexable: p.indexable,
        })),
      });
    }
  }

  /* ---- Persist AuditLink records ---- */
  if (allLinks.length > 0) {
    const LINK_BATCH = 200;
    // Cap total links to avoid blowing up storage
    const linksToStore = allLinks.slice(0, 10000);
    for (let i = 0; i < linksToStore.length; i += LINK_BATCH) {
      const chunk = linksToStore.slice(i, i + LINK_BATCH);
      await db.auditLink.createMany({
        data: chunk.map((l) => ({
          crawlId,
          sourceUrl: l.sourceUrl,
          targetUrl: l.targetUrl,
          anchorText: l.anchorText,
          isInternal: l.isInternal,
          isNofollow: l.isNofollow,
          statusCode: l.statusCode,
        })),
      });
    }
  }

  /* ---- Compare published pages with the accepted canonical knowledge document ---- */
  const projectId = (await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } }))?.projectId;
  let knowledge: Awaited<ReturnType<typeof readBusinessKnowledge>> | null = null;
  let knowledgeReason: string | null = null;
  let knowledgeDocumentId: string | null = null;
  if (projectId) {
    const head = await db.businessKnowledgeDocument.findUnique({ where: { projectId }, select: { logicalId: true, acceptedRevision: true } });
    knowledgeDocumentId = head?.logicalId ?? null;
    if (head?.logicalId && head.acceptedRevision != null) {
      try { knowledge = await readBusinessKnowledge(projectId, head.logicalId, head.acceptedRevision, "accepted"); }
      catch (error) { knowledgeReason = error instanceof Error ? error.message : "Canonical business knowledge could not be read"; }
    } else knowledgeReason = head ? "No accepted business knowledge revision exists" : "Canonical business knowledge document is missing";
  } else knowledgeReason = "Site is not linked to a project with canonical business knowledge";
  for (const page of auditPages) {
    const findings = knowledge
      ? auditSchemaSemantics(page.projection, knowledge)
      : [{ code: "BUSINESS_KNOWLEDGE_UNAVAILABLE", field: "businessKnowledge", status: "unknown" as const, evidence: knowledgeReason ?? "Canonical business knowledge unavailable", key: "BUSINESS_KNOWLEDGE_UNAVAILABLE:businessKnowledge", location: "canonical business knowledge API" }];
    for (const finding of findings) {
      issues.push({ url: page.url, type: "MISSING_SCHEMA", severity: finding.status === "mismatch" ? "WARNING" : "INFO",
        message: finding.status === "mismatch" ? `Business content mismatch: ${finding.field}` : `Business consistency audit unknown: ${finding.field}`,
        details: { kind: "business_schema_semantics", code: finding.code, stableKey: `${page.url}:${finding.key}`, field: finding.field, status: finding.status,
          expected: finding.expected ?? null, observed: finding.observed ?? null, observedLocation: finding.location ?? null,
          evidence: finding.evidence, knowledgeDocumentId, knowledgeRevision: knowledge?.revision ?? null } });
    }
  }

  /* ---- Persist CrawlIssue records ---- */
  const semanticsIssues = issues.filter((issue) => issue.details?.kind === "business_schema_semantics");
  await persistSchemaSemanticsIssues(db, crawlId, semanticsIssues as Array<{ url: string; severity: "INFO" | "WARNING"; message: string; details: Record<string, unknown> }>);
  const toSave = issues.filter((issue) => issue.details?.kind !== "business_schema_semantics").slice(0, 1000);
  if (toSave.length) {
    await db.crawlIssue.createMany({ data: toSave.map((i) => ({
        crawlId,
        url: i.url,
        type: i.type,
        severity: i.severity,
        message: i.message,
        details: (i.details ?? undefined) as undefined | Record<string, string | number | boolean | null>,
      })) });
  }

  // Thin content pages as INFO issues
  const sitemapCoverageSet = new Set(sitemapUrls);
  for (const page of pages.filter((candidate) => candidate.indexable && !sitemapCoverageSet.has(candidate.url))) {
    issues.push({ url: page.url, type: "MISSING_SCHEMA", severity: "WARNING", message: `Indexable page is absent from sitemap: ${page.url}`,
      details: { kind: "sitemap_coverage", gapIdentity: `sitemap:${page.url}`, page: page.url } });
  }

  // Thin content pages as INFO issues
  const thin = successfulPages.filter((p) => p.contentScore < 60);
  if (thin.length) {
    await db.crawlIssue.createMany({
      data: thin.slice(0, 50).map((p) => ({
        crawlId,
        url: p.url,
        type: "MISSING_DESCRIPTION" as IssueType,
        severity: "INFO" as IssueSeverity,
        message: `On-page content score ${p.contentScore}/100 (${p.wordCount} words)`,
        details: {
          kind: "content_score",
          contentScore: p.contentScore,
          wordCount: p.wordCount,
          title: p.title,
          h1Count: p.h1s.length,
        },
      })),
    });
  }

  // Crawl summary issue
  await db.crawlIssue.create({
    data: {
      crawlId,
      url: seedUrl,
      type: "MISSING_SCHEMA",
      severity: "INFO",
      message: "Crawl summary",
      details: {
        kind: "crawl_summary",
        pages: pages.map((p) => ({
          url: p.url,
          statusCode: p.statusCode,
          title: p.title,
          contentScore: p.contentScore,
          wordCount: p.wordCount,
          outlinks: p.internalOutlinks.length,
          externalOutlinks: p.externalOutlinks.length,
          inlinks: inlinkCount.get(p.url) || 0,
        })),
        sitemapUrls: sitemapUrls.length,
        missingFromSitemap: missingFromSitemap.length,
        orphans: orphans.length,
        avgContentScore,
      },
    },
  });

  /* ---- Finalize crawl record ---- */
  const finalIssues = await db.crawlIssue.count({
    where: { crawlId },
  });

  await db.crawl.update({
    where: { id: crawlId },
    data: {
      status: "COMPLETED",
      finishedAt: new Date(),
      pagesFound: pages.length,
      issuesFound: finalIssues,
      healthScore,
    },
  });

  return {
    crawlId,
    pagesFound: pages.length,
    issuesFound: finalIssues,
    healthScore,
    sitemapUrls: sitemapUrls.length,
    missingFromSitemap: missingFromSitemap.length,
    orphanCandidates: orphans.length,
    avgContentScore,
  };
}
