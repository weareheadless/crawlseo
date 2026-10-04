# PLAN-AI: AI-Powered SEO Optimization Recommendations

> Date: 2026-07-23 — Revised after codebase audit
> Status: Streamlined for results, not data display

---

## 0. Audit Findings (What Changed From V1)

### Killed
- **Prioritizer AI call.** `getAllOpportunities()` already does algorithmic prioritization (impression-weighted, CTR-gap-sorted, severity-tagged). An AI can't beat the math — it echoes what the numbers already say. Cost saved: ~$0.005/analysis.
- **`buildTechnicalReport()` as a 120-line new file.** 90% overlap with existing `engine.ts` + `remediation.ts` + `AuditPage` + `CrawlIssue` + `VitalsReport` + `AuditLink`. Replaced by a 50-line serialization adapter.
- **Two-step wizard UX.** 6-state button (`idle → diagnosing → prioritizing → awaiting_confirm → synthesizing → done`) is friction the target user (non-SEO-specialist founder) won't tolerate. Replaced by per-row "Analyze" buttons.

### Added
- **SERP feature analysis.** Detecting featured snippets, PAA boxes, image packs, video carousels. This is what turns position #5 into equivalent #1 visibility.
- **Competitor content depth comparison.** DataForSEO crawls top 3 competitors' on-page content. Word count, heading structure, entity coverage vs yours.
- **Implementation tracking.** `AiAnalysis.status` field (pending → implemented → verified). Before/after GSC comparison.
- **3 title variants.** Different angles: keyword-forward, curiosity/CTR-max, authority/social-proof.
- **Generated JSON-LD code.** Not just "add Article schema" — actual copy-pasteable `<script>` block.
- **Thin content detection.** Flag pages where word count is below viable threshold for the target query type.

### DataForSEO for competitor analysis
- `getSerpResults()` — top 10 organic results + SERP features
- `getCompetitorContent()` — crawl top 3 competitor pages via on-page API for content depth comparison

---

## 1. Philosophy

### The AI is the strategist, not the auditor.

A world-class SEO consultant doesn't count title characters — the crawler already does that. They read the audit, look at competitors, and exercise **judgment**: which fix matters most, and exactly what content to write.

This architecture mirrors that workflow:

| Role | Who does it | Cost |
|---|---|---|
| **Auditor** — detect every structural issue deterministically | Existing crawler + remediation | Free |
| **Serializer** — format existing audit data for AI consumption | 50-line adapter | Free |
| **Strategist** — weigh trade-offs, analyze competitors, produce content brief | AI (1 call) | ~$0.027 |

### Core constraint

> **1 opportunity = 1 AI call. Single click from the opportunities feed.**

---

## 2. Architecture: Single-Click Deep Dive

```
┌──────────────────────────────────────────────────────────────┐
│ USER SEES OPPORTUNITIES FEED (already built)                 │
│                                                              │
│  #1 [striking_distance] "free SEO tools" HIGH severity       │
│      pos #5 · 1,200 imp/mo · [🔍 Analyze with AI]            │
│                                                              │
│  #2 [low_ctr] "small business SEO" MEDIUM severity           │
│      CTR 4.1% vs 11% expected · [🔍 Analyze with AI]         │
│                                                              │
│  #3 [content_decay] /blog/seo-trends-2024 HIGH severity      │
│      −62% clicks · [🔍 Analyze with AI]                      │
│                                                              │
│  User clicks ONE "Analyze" button on the row they care about. │
├──────────────────────────────────────────────────────────────┤
│ SINGLE AI CALL (~$0.027)                                     │
│                                                              │
│ 1. Serialize existing audit data for the page                │
│    (AuditPage + CrawlIssue + VitalsReport + AuditLink)       │
│                                                              │
│ 2. Fetch SERP data via DataForSEO:                           │
│    → getSerpResults(query) — top 10 + SERP features          │
│    → Crawl top 3 competitor pages (on-page content)          │
│                                                              │
│ 3. Fetch keyword research via DataForSEO:                    │
│    → keywordResearch(query) — related terms + volumes        │
│                                                              │
│ 4. Build prompt with ALL layers:                             │
│    → Pre-digested technical audit                            │
│    → Competitor content depth comparison                     │
│    → SERP features present for this query                    │
│    → Keyword opportunities with volumes                      │
│    → GSC trend (12-week position/CTR history)                │
│                                                              │
│ 5. AI produces: diagnosis, strategy, prioritized fixes,      │
│    content brief with specific headings + keywords,          │
│    3 title variants, JSON-LD code, expected impact           │
└──────────────────────────────────────────────────────────────┘
```

### Why single-click

The opportunities feed already shows the user what matters. They don't need an AI to pick for them — they need the AI to tell them **exactly what to do** about the opportunity they already identified as important.

---



## 3. Key Decisions

### 3.1 OpenAI key — `.env`, not a UI

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o          # optional, defaults to gpt-4o
OPENAI_BASE_URL=...            # optional, for proxies/local LLMs
```

No UI. No database row. No encryption.

### 3.2 DataForSEO — 3 calls per analysis (all after user click)

| Call | Endpoint | Purpose |
|---|---|---|
| `getSerpResults()` | `/v3/serp/google/organic/live/regular` | Top 10 results + SERP features |
| `getCompetitorContent()` | `/v3/on_page/instant_pages` | Crawl top 3 competitors' on-page content |
| `keywordResearch()` | Already exists | Related keywords + volumes + difficulty |

All guarded: only if DataForSEO key configured. Graceful fallback if unavailable.

### 3.3 No speculative API calls

DataForSEO is never called until the user explicitly clicks "Analyze" on a specific opportunity.

---

## 4. Database

### Add to `prisma/schema.prisma`

```prisma
model AiAnalysis {
  id               String    @id @default(cuid())
  siteId           String
  opportunityType  String    // striking_distance | low_ctr | content_decay | cannibalization
  targetQuery      String?
  targetUrl        String?
  status           String    @default("pending") // pending | implemented | verified | dismissed
  inputSnapshot    Json      // exact data sent to AI (reproducible, debuggable)
  recommendation   Json      // structured AI response
  model            String    @default("gpt-4o")
  tokensIn         Int?
  tokensOut        Int?
  gscBefore        Json?     // GSC snapshot at time of analysis (for before/after)
  implementedAt    DateTime?
  verifiedAt       DateTime?
  outcomeNotes     String?
  createdAt        DateTime  @default(now())

  site             Site      @relation(fields: [siteId], references: [id], onDelete: Cascade)

  @@index([siteId, createdAt])
  @@index([siteId, status])
}
```

No other schema changes.

```bash
npx prisma migrate dev --name add_ai_analysis
```

---

## 5. Files

```
NEW FILES (4):
  lib/ai/serialize-audit.ts                 (~50 lines — read existing DB rows → prompt-ready JSON)
  lib/ai.ts                                 (~250 lines — synthesize + callOpenAI + prompt builder)
  app/api/sites/[siteId]/ai/route.ts         (~55 lines — single POST, single mode)
  components/ai/recommendation-card.tsx       (~150 lines — displays result, copy buttons, status toggle)

MODIFIED FILES (5):
  prisma/schema.prisma                      (+25 lines, AiAnalysis model)
  lib/dataforseo/client.ts                  (+120 lines, getSerpResults + getCompetitorContent)
  app/(dashboard)/sites/[siteId]/opportunities/page.tsx (+35 lines, per-row Analyze buttons)
  components/ai/analyze-opportunity-button.tsx (NEW ~40 lines, simple button with loading/done states)
  components/ui/button.tsx                   (no changes needed, reuse existing variants)

DELETED FROM V1 PLAN:
  lib/ai/technical-report.ts                (REPLACED by serialize-audit.ts)
  components/ai/analyze-button.tsx           (REPLACED by per-row buttons + inline cards)

TOTAL: 9 files, ~685 lines (down from ~800)
```

---

## 6. `lib/ai/serialize-audit.ts` — Audit Serializer

**Reads existing DB rows. Does not compute new metrics.** The crawler already did the work.

```typescript
// serializeAudit(siteId, url) → prompt-ready JSON section
//
// Reads (all existing):
//   db.auditPage.findFirst({ where: { crawl: { siteId }, url }, orderBy: { crawl: { startedAt: "desc" } } })
//   db.crawlIssue.findMany({ where: { crawl: { siteId }, url } })
//   db.vitalsReport.findFirst({ where: { siteId, url }, orderBy: { date: "desc" } })
//   db.auditLink.findMany({ where: { crawl: { siteId }, sourceUrl: url } })
//   db.auditLink.findMany({ where: { crawl: { siteId }, targetUrl: url } })
//
// Outputs:
{
  url: "/tools",
  latestCrawl: "2026-07-15",

  // Direct from AuditPage
  title: { value: "Our SEO Tools", length: 14, status: "WARN" },  // <30 chars = WARN
  metaDescription: { value: "We offer...", length: 142, status: "PASS" },
  h1Count: 1,
  h1s: ["Our SEO Tools"],
  h2Count: 2,
  wordCount: 450,                                     // ⚠️ THIN CONTENT flag if <800 for blog-style pages
  indexable: true,
  canonical: "https://brandson.digital/tools",
  canonicalSelfRef: true,
  hasSchema: false,
  imageCount: 5,
  imagesMissingAlt: 3,
  responseTimeMs: 340,
  byteSize: 422000,

  // From CrawlIssue (already has type, severity, message)
  issues: [
    { type: "MISSING_SCHEMA", severity: "WARNING", fix: REMEDIATION.MISSING_SCHEMA.howToFix },
    { type: "MISSING_ALT", severity: "WARNING", fix: REMEDIATION.MISSING_ALT.howToFix },
  ],

  // From AuditLink
  linking: {
    incomingCount: 3,
    incomingAnchors: ["our tools", "these tools", "free SEO analyzer"],
    outgoingInternal: 12,
    outgoingExternal: 2,
    isOrphan: false,
    // Suggested missing links (keyword-overlap heuristic from other AuditPages)
    suggestedIncoming: [
      { source: "/blog/keyword-research", anchorText: "free SEO tools we recommend", relevance: 0.87 },
    ],
  },

  // From VitalsReport
  vitals: {
    device: "MOBILE",
    perfScore: 72,
    lcp: 3.1, cls: 0.04, inp: 180, ttfb: 0.9,
  },

  // Computed (lightweight)
  freshness: { lastCrawled: "2026-07-15", daysAgo: 8, isStale: false },
  thinContent: true,                                 // wordCount < 800 for this page type
  duplicateTitleCount: 1,                            // from CrawlIssue DUPLICATE_TITLE count
}
```

### What this does NOT do

- ❌ Does not re-compute health scores (use existing `Crawl.healthScore`)
- ❌ Does not re-detect issues (use existing `CrawlIssue` rows)
- ❌ Does not re-parse HTML (use existing `AuditPage` columns)
- ❌ Does not apply thresholds beyond simple length/type checks

---

## 7. `lib/dataforseo/client.ts` — New Methods

Add to existing file.

### 7.1 `getSerpResults()` — Organic results + SERP features

```typescript
export type SerpResult = {
  position: number
  url: string
  title: string
  description: string
  domain: string
}

export type SerpFeatures = {
  featuredSnippet: { url: string; title: string; description: string } | null
  peopleAlsoAsk: { question: string; answer: string }[]
  imagePack: boolean
  videoCarousel: boolean
  topStories: boolean
  knowledgePanel: Record<string, string> | null
}

export async function getSerpResults(
  userId: string,
  query: string,
  language?: string,
  location?: number
): Promise<{ organic: SerpResult[]; features: SerpFeatures } | null>
```

- Endpoint: `POST /v3/serp/google/organic/live/regular`
- Extracts both organic results AND featured snippet / PAA / image/video presence
- Returns `null` if no DataForSEO key or API error

### 7.2 `getCompetitorContent()` — Crawl competitor pages

```typescript
export type CompetitorContent = {
  url: string
  title: string
  description: string
  wordCount: number
  headings: { tag: string; text: string }[]
  hasSchema: boolean
  schemaTypes: string[]
  imageCount: number
  internalLinkCount: number
  externalLinkCount: number
}

export async function getCompetitorContent(
  userId: string,
  urls: string[]  // top 3 competitor URLs from getSerpResults
): Promise<CompetitorContent[] | null>
```

- Endpoint: `POST /v3/on_page/instant_pages`
- Crawls up to 3 competitor URLs in one batch
- Returns structured on-page data for content depth comparison
- Returns `null` if no DataForSEO key or API error

---

## 8. `lib/ai.ts` — AI Client + Prompt Builder

Single file. Single exported function.

### Exports

```typescript
export async function analyze(
  siteId: string,
  opportunity: OpportunityRef
): Promise<AnalysisResult>

export type AnalysisResult = {
  analysisId: string
  diagnosis: string
  strategy: string
  technicalFixes: ActionItem[]
  contentFixes: ActionItem[]       // now includes specific H2s + keywords
  contentBrief: ContentBrief       // NEW — actionable writing instructions
  titleSuggestions: TitleVariant[] // NEW — 3 variants, not 1
  metaSuggestion: string | null
  schemaCode: string | null        // CHANGED — actual JSON-LD code, not just type name
  internalLinkingSuggestions: LinkSuggestion[]
  expectedImpact: string
  serpFeaturesNote: string | null  // NEW — "This query has a featured snippet you could capture"
}

export type ContentBrief = {
  targetWordCount: number
  sections: {
    heading: string
    targetKeyword: string
    keywordVolume: number | null
    wordCount: number
    purpose: string                // e.g., "Define the category", "Compare alternatives"
  }[]
}

export type TitleVariant = {
  angle: "keyword-forward" | "ctr-optimized" | "authority"
  title: string
  rationale: string                // e.g., "Matches 'best X' intent pattern"
}
```

### Internal structure

```
callOpenAI(messages):
  • Reads OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL from env
  • POST /v1/chat/completions
  • response_format: { type: "json_object" } (OpenAI structured output)
  • Strips markdown ```json wrappers if present as fallback

analyze(siteId, opportunity):
  1. Get latest crawl → db.crawl.findFirst({ where: { siteId, status: "COMPLETED" } })
  2. Serialize audit → serializeAudit(siteId, opportunity.url) [NEW]
  3. Get GSC trend → db.keyword aggregated by week for the query [EXISTING]
  4. Get page content → db.auditPage from latest crawl [EXISTING]
  5. IF DataForSEO configured (3 calls in parallel):
       → getSerpResults(userId, query)
       → getCompetitorContent(userId, top 3 competitor URLs from SERP)
       → keywordResearch(userId, query) [EXISTING]
  6. Build prompt (see §8.1)
  7. callOpenAI(prompt)
  8. Store AiAnalysis row (status: "pending", gscBefore: snapshot)
  9. Return result
```

### 8.1 Synthesize prompt (the only prompt)

```
You are an SEO specialist. Build a prioritized action plan for this ONE page.

Your job: weigh the technical findings against the competitive landscape
and produce a priority-ordered plan with specific, implementable changes.

A "FAIL" in the technical report does NOT automatically mean it's the
top priority — if content depth is the real gap, that should rank higher
than fixing a few alt texts.

=== 1. PERFORMANCE (GSC) ===
Query: "free SEO tools"
Position: #5 | CTR: 6.2% | Impressions: 1200/mo
12-week trend: position #8 → #7 → #6 → #5 (steady improvement, climbing)

=== 2. TECHNICAL AUDIT (from crawler) ===
[SERIALIZED AUDIT JSON from serializeAudit()]

=== 3. PAGE CONTENT ===
URL: https://brandson.digital/tools
Word count: 450 ⚠️ THIN CONTENT (below 800-word threshold for this page type)
Heading structure:
  H1: "Our SEO Tools"
  H2: "Keyword Research" / H2: "Backlink Checker"
Content excerpt (first 1500 chars):
  "At Brandson Digital, we offer a comprehensive suite of SEO tools..."
  [truncated]

=== 4. SERP LANDSCAPE ===
[from DataForSEO getSerpResults, or "SERP data unavailable"]

SERP FEATURES DETECTED:
  • Featured snippet: YES — currently held by ahrefs.com
  • People Also Ask: 4 questions present
  • Image pack: NO
  • Video carousel: YES

ORGANIC RESULTS:
  #1 ahrefs.com/free-seo-tools — "Free SEO Tools: 15 Best Tools for 2026 (Actually Free)"
     Description: "We tested 50+ free SEO tools. Here are the 15 that actually work..."
  #2 searchenginejournal.com/free-seo-tools/ — "15 Free SEO Tools Worth Using in 2026"
  #3 backlinko.com/free-seo-tools — "The Definitive List of Free SEO Tools (2026)"
  #4 semrush.com/blog/free-seo-tools/ — "30 Best Free SEO Tools (2026 Edition)"
  #5 moz.com/free-seo-tools — "Free SEO Tools — Moz"

=== 5. COMPETITOR CONTENT DEPTH ===
[from DataForSEO getCompetitorContent, or "Competitor content data unavailable"]

  #1 ahrefs.com/free-seo-tools:
     • Word count: 2,450 (vs your 450 — 5.4x difference)
     • Headings: H1 + 8 H2s + 5 H3s (vs your H1 + 2 H2s)
     • Their H2s: "Keyword Research Tools", "Backlink Checkers", "Technical SEO",
       "Rank Tracking", "On-Page SEO", "Free vs Paid Comparison", "How We Tested",
       "FAQ"
     • Schema: Article + ItemList + FAQ + BreadcrumbList
     • Images: 15 (all with alt text)

  #2 searchenginejournal.com/free-seo-tools/:
     • Word count: 1,850
     • Headings: H1 + 6 H2s + 3 H3s
     • Their H2s: "Best Free Keyword Tools", "Backlink Analysis Tools",
       "Technical SEO Auditors", "Rank Trackers", "Content Optimization",
       "Our Testing Methodology"
     • Schema: Article + BreadcrumbList

  #3 backlinko.com/free-seo-tools:
     • Word count: 3,100
     • Headings: H1 + 12 H2s + 8 H3s
     • Schema: Article + ItemList + FAQ + BreadcrumbList + HowTo

COMPETITIVE GAP SUMMARY:
  • Average competitor word count: 2,467 (you: 450)
  • Average competitor H2s: 8.7 (you: 2)
  • All 3 competitors have comparison sections you lack
  • All 3 use "2026" or current year in title
  • 2/3 have testing methodology sections (E-E-A-T signal)

=== 6. KEYWORD RESEARCH ===
[from DataForSEO keywordResearch, or "Keyword research data unavailable"]

Related keywords to target (with search volume + difficulty):
  • "best free SEO tools" — 1,200/mo | difficulty: 45
  • "free SEO tools for beginners" — 590/mo | difficulty: 32
  • "free keyword research tools" — 480/mo | difficulty: 38
  • "SEO tools comparison" — 320/mo | difficulty: 51
  • "free backlink checker tools" — 280/mo | difficulty: 29
  • "free technical SEO audit tools" — 210/mo | difficulty: 35
  • "are free SEO tools worth it" — 170/mo | difficulty: 18 (question-based → PAA)
  • "free SEO tools vs paid" — 140/mo | difficulty: 40

=== 7. INTERNAL LINK GRAPH ===
Incoming: 3 links from /(homepage), /blog/seo-checklist, /services
Suggested missing links:
  • /blog/keyword-research → "free SEO tools we recommend" (relevance: 0.87)
  • /blog/backlink-analysis → "free backlink tools" (relevance: 0.72)

---

Return ONLY valid JSON (use this exact structure):
{
  "diagnosis": "one sentence — the single biggest factor holding this page back",
  "strategy": "one paragraph — the overall approach",

  "technicalFixes": [
    {
      "priority": 1,
      "category": "title|meta|headings|speed|indexability|schema|images|vitals|canonical|mobile",
      "finding": "what's wrong",
      "action": "specific fix instruction",
      "effort": "low|medium|high",
      "impact": "low|medium|high"
    }
  ],

  "contentFixes": [
    {
      "priority": 1,
      "category": "depth|structure|intent|freshness|e-e-a-t|internal_linking|keyword_targeting",
      "finding": "what's missing or weak — reference competitor gaps",
      "action": "specific content change — reference specific keywords with volumes",
      "effort": "low|medium|high",
      "impact": "low|medium|high"
    }
  ],

  "contentBrief": {
    "targetWordCount": 2000,
    "sections": [
      {
        "heading": "exact H2 text to add",
        "targetKeyword": "keyword this section targets",
        "keywordVolume": 320,
        "wordCount": 200,
        "purpose": "what this section should accomplish"
      }
    ]
  },

  "titleSuggestions": [
    {
      "angle": "keyword-forward",
      "title": "exact proposed title",
      "rationale": "why this angle"
    },
    {
      "angle": "ctr-optimized",
      "title": "exact proposed title",
      "rationale": "why this angle"
    },
    {
      "angle": "authority",
      "title": "exact proposed title",
      "rationale": "why this angle"
    }
  ],

  "metaSuggestion": "exact proposed meta description or null",

  "schemaCode": "<script type=\\\"application/ld+json\\\">\\n{ ... actual JSON-LD ... }\\n</script> or null",

  "internalLinkingSuggestions": [
    { "source": "/blog/keyword-research", "anchorText": "our recommended free SEO tools" }
  ],

  "expectedImpact": "quantified estimate with timeline",

  "serpFeaturesNote": "This query has a featured snippet. To capture it: structure your H2s as questions matching the PAA box, and provide concise 40-60 word answers directly below each H2. Add FAQ schema."
}
```

### 8.2 Prompt rules

- **"Return ONLY valid JSON"** is mandatory. Also set `response_format: { type: "json_object" }` in the API call.
- **Do NOT ask the AI to re-discover technical issues.** Feed the serialized audit. The AI's job is prioritization + content strategy.
- **Separate `technicalFixes` from `contentFixes`.** Different mental models, different output fields.
- **`contentBrief` is the most important output.** It tells the user exactly what to write.
- **If SERP/competitor data is unavailable**, the prompt says `"SERP data unavailable — skip competitor analysis and focus on on-page improvements"`.
- **Truncate page content at 1500 chars** with a `[truncated]` marker.
- **Include thin content flag** in the prompt when wordCount < threshold for the page type.
- **Include SERP feature detection** for featured snippet and PAA targeting advice.

---

## 9. `app/api/sites/[siteId]/ai/route.ts` — API Route

Single route, single mode.

```
POST /api/sites/[siteId]/ai

Body: {
  opportunity: {
    type: "striking_distance" | "low_ctr" | "content_decay" | "cannibalization",
    query: "free SEO tools",     // optional (not present for content_decay)
    url: "/tools"                // optional (not present for striking_distance without known URL)
  }
}

Response: AnalysisResult (see §8)
```

**Auth:** Reuse existing `getUserIdFromCookies()` pattern from other API routes.

**Error handling:**

| Error | Status | Response |
|---|---|---|
| No `OPENAI_API_KEY` in env | 400 | `{ error: "OPENAI_API_KEY not configured" }` |
| Not authenticated | 401 | `{ error: "Unauthorized" }` |
| AI provider error | 502 | `{ error: "AI provider error: ..." }` |
| DataForSEO fails | — | Silently skip SERP/competitor data, continue with AI |
| No crawl data for page | — | Send `"No crawl data available for this page — analysis limited to GSC metrics"` |

---

## 10. UI Components

### 10.1 Per-row "Analyze" buttons on opportunities page

Add an "🔍 Analyze" button to each row in the existing opportunities feed. No separate wizard component.

```tsx
// In opportunities/page.tsx, per feed item:
{data.feed.map((item, i) => (
  <li key={...} className="flex ...">
    <div>{/* existing title, detail, badges */}</div>
    <AnalyzeOpportunityButton
      siteId={siteId}
      opportunity={item}
    />
  </li>
))}
```

`AnalyzeOpportunityButton` states:

| State | UI |
|---|---|
| `idle` | "🔍 Analyze" button (small, outline variant, reuse existing Button) |
| `loading` | Spinner + "Analyzing..." |
| `done` | Renders `<RecommendationCard>` inline below the row |
| `error` | Error message + [Retry] |

No wizard. No confirmation step. Single click → loading → card.

### 10.2 `components/ai/recommendation-card.tsx` (~150 lines)

Displays the structured JSON from analysis.

```
┌──────────────────────────────────────────────────────────────┐
│ 📋 AI Analysis: "free SEO tools" on /tools                    │
│                                                              │
│ 🩺 Diagnosis                                                 │
│ Your 450-word tool listing page is competing against          │
│ 2,450-word curated lists. Content depth is 5.4x below avg.   │
│                                                              │
│ 🎯 Strategy                                                  │
│ Transform from a simple tool list into a curated,              │
│ opinionated guide. Add comparison criteria, pros/cons,        │
│ and real use cases. Refresh the 2026 angle in the title.      │
│                                                              │
│ 🏆 SERP Opportunity                                          │
│ This query has a featured snippet (held by ahrefs.com).       │
│ Structure H2s as questions + 40-60 word answers to capture it.│
│                                                              │
│ ── 🔧 Technical Fixes ──                                     │
│                                                              │
│ #1 [schema] 🔴 HIGH impact · 🟢 LOW effort                    │
│     Add Article + ItemList + FAQ JSON-LD schema               │
│                                                              │
│ ── ✍️ Content Fixes ──                                       │
│                                                              │
│ #1 [depth] 🔴 HIGH impact · 🟡 MEDIUM effort                  │
│     Expand from 450 to 2,000+ words. Competitors average       │
│     2,467 words with 8.7 H2 sections.                         │
│                                                              │
│ ── 📝 Content Brief ──                                       │
│                                                              │
│ Target: 2,000 words across 8 sections                         │
│                                                              │
│ Section 1: "Best Free Keyword Research Tools"                 │
│   Target keyword: "free keyword research tools" (480/mo)     │
│   ~250 words — List and compare top 5 tools                   │
│                                                              │
│ Section 2: "Free Backlink Checker Tools Compared"             │
│   Target keyword: "free backlink checker tools" (280/mo)     │
│   ~200 words — Accuracy comparison of 4 tools                 │
│                                                              │
│ [... more sections ...]                                       │
│                                                              │
│ ── 📝 Title Suggestions ──                                   │
│                                                              │
│ 🔑 Keyword-forward:                            [📋 Copy]     │
│ "15 Best Free SEO Tools in 2026 (Tested & Ranked)"           │
│ Rationale: Matches "best X" + year intent pattern             │
│                                                              │
│ 🧲 CTR-optimized:                              [📋 Copy]     │
│ "I Tested 50+ Free SEO Tools. Here Are the 15 Worth Using"   │
│ Rationale: First-person narrative = higher CTR               │
│                                                              │
│ 🏛️ Authority:                                 [📋 Copy]     │
│ "Free SEO Tools That Actually Work: 2026 Expert Review"      │
│ Rationale: "Expert review" signals authority                  │
│                                                              │
│ 📝 Meta Suggestion                             [📋 Copy]     │
│ "I tested 50+ free SEO tools so you don't have to..."        │
│                                                              │
│ 🏷️  Schema Code                                [📋 Copy]     │
│ <script type="application/ld+json">                           │
│ { "@context": "https://schema.org", ... }                     │
│ </script>                                                     │
│                                                              │
│ 🔗 Internal Linking                             [→]          │
│ /blog/keyword-research → "our recommended free SEO tools"    │
│ /blog/backlink-analysis → "best free backlink tools"         │
│                                                              │
│ 📊 Expected Impact                                           │
│ Position #2-4 within 4-6 weeks. Title + content depth         │
│ + schema = estimated 40-60 additional clicks/month.          │
│                                                              │
│ ── Status ──                                                 │
│ [Mark Implemented]  [Dismiss]                                │
│                                                              │
│ After implementing, come back and click "Mark Implemented"    │
│ to track before/after results.                                │
└──────────────────────────────────────────────────────────────┘
```

### 10.3 Status tracking

- **"Mark Implemented"** → sets `AiAnalysis.status = "implemented"`, records `implementedAt`
- **"Dismiss"** → sets `AiAnalysis.status = "dismissed"`
- After 21+ days, the user can click **"Verify Results"** → compares current GSC data against `gscBefore` snapshot, shows before/after delta, sets `status = "verified"`

---

## 11. Implementation Order

| Step | What | Est. lines | Depends on |
|---|---|---|---|
| **1** | Add `AiAnalysis` model + migration | +25 | — |
| **2** | Add `getSerpResults()` + `getCompetitorContent()` to DFSEO client | +120 | — |
| **3** | Create `lib/ai/serialize-audit.ts` | +50 | Step 1 |
| **4** | Create `lib/ai.ts` (analyze + callOpenAI + prompt) | +250 | Steps 1, 2, 3 |
| **5** | Create `app/api/sites/[siteId]/ai/route.ts` | +55 | Step 4 |
| **6** | Create `components/ai/recommendation-card.tsx` | +150 | Step 5 |
| **7** | Create `components/ai/analyze-opportunity-button.tsx` | +40 | Steps 5, 6 |
| **8** | Wire buttons into opportunities page | +35 | Step 7 |

---

## 12. Cost Summary

| Step | What | Cost |
|---|---|---|
| Audit serialization | Read existing DB rows | $0 |
| SERP + competitor fetch | 3 DataForSEO calls | ~$0.004 |
| AI synthesis | 1 AI call (~6K in / ~1.5K out) | ~$0.023 |
| **Full analysis** | | **~$0.027** |

At 20 analyses/month: ~$0.54/month.

---

## 13. Reuse Checklist

| Existing module | Used in | How |
|---|---|---|
| `getAllOpportunities()` | Opportunities page | Already renders the feed |
| `getTopKeywords()` | `lib/ai.ts` | Keyword position/CTR history |
| `db.auditPage` | `serialize-audit.ts` | Title, meta, H1s, content, speed, indexability, schema, images |
| `db.crawlIssue` | `serialize-audit.ts` | Structural issues per page |
| `db.vitalsReport` | `serialize-audit.ts` | LCP, CLS, INP, TTFB, perf score |
| `db.auditLink` | `serialize-audit.ts` | Incoming/outgoing links, orphan detection, suggested links |
| `REMEDIATION` constant | `serialize-audit.ts` | Fix instructions for every crawl issue type |
| `keywordResearch()` | `lib/ai.ts` | Related keywords + volumes + difficulty (already exists) |
| `getCredentials()` | `getSerpResults()`, `getCompetitorContent()` | DataForSEO auth |
| `dataforseoPost()` | `getSerpResults()`, `getCompetitorContent()` | DataForSEO API call |
| `getUserIdFromCookies()` | `route.ts` | Session validation |
| `Crawl.healthScore` | `serialize-audit.ts` | Use existing health score, don't recompute |

---

## 14. Anti-Patterns

| ❌ Don't | ✅ Do |
|---|---|
| Ask AI to count title characters or detect missing alt text | Serialize existing crawler data into the prompt |
| Create a two-step wizard with confirmation | Single-click "Analyze" per opportunity row |
| Compute a new health score | Use existing `Crawl.healthScore` |
| Generate one title suggestion | Generate 3 variants with different angles |
| Say "add schema" | Generate the actual JSON-LD `<script>` block |
| Say "add more content" | Generate a content brief with specific H2s, keywords, and word counts |
| Ignore SERP features | Detect featured snippets + PAA and give capture instructions |
| Fetch page content via HTTP | Use existing `AuditPage` from crawl |
| Create a new DFSEO client class | Add methods to existing `lib/dataforseo/client.ts` |
| Skip implementation tracking | Track status: pending → implemented → verified with before/after GSC |
| Store OpenAI key in DB | Read `OPENAI_API_KEY` from `.env` |
| Parse AI response with regex | Use `response_format: { type: "json_object" }` + JSON.parse fallback |

---

## 15. Testing Checklist

- [ ] `serializeAudit()` returns prompt-ready JSON for a page with crawl data
- [ ] `serializeAudit()` handles pages with no crawl data (returns minimal report)
- [ ] `serializeAudit()` handles pages with no vitals data (vitals: null)
- [ ] `serializeAudit()` suggests internal links correctly (excludes existing links)
- [ ] `serializeAudit()` flags thin content when wordCount < threshold
- [ ] `getSerpResults()` returns organic results + SERP features
- [ ] `getSerpResults()` gracefully returns null when no DataForSEO key
- [ ] `getCompetitorContent()` returns structured content for top 3 URLs
- [ ] `getCompetitorContent()` gracefully returns null when no DataForSEO key
- [ ] `analyze()` works with no DataForSEO key (graceful SERP/competitor skip)
- [ ] `analyze()` works when page has no crawl data
- [ ] AI returns parseable JSON (uses `response_format: json_object`)
- [ ] API route returns 400 when `OPENAI_API_KEY` missing
- [ ] API route returns 401 when unauthenticated
- [ ] `AiAnalysis` row created with status "pending" and gscBefore snapshot
- [ ] Per-row Analyze button: idle → loading → card (no wizard)
- [ ] Recommendation card renders all sections correctly
- [ ] Copy buttons on title/meta/schema work
- [ ] "Mark Implemented" updates status and records timestamp
- [ ] "Verify Results" shows before/after GSC comparison
- [ ] DataForSEO calls happen only after user clicks, never speculatively
- [ ] Content brief sections include specific H2 text, target keywords, and volumes
