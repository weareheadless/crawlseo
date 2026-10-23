# PLAN: Research Engine and Central Action Queue

> Status: proposed  
> Scope: CrawlSEO as the shared research, content, and delivery control plane for HelloAda sites and apps

## 1. Summary

CrawlSEO already has the beginnings of a shared SEO platform:

- GSC, GA4, crawl, vitals, and DataForSEO data
- Project provisioning, service credentials, and integration grants
- A durable job worker
- Content Studio draft generation
- API and MCP access

What it does not have is a durable model for the thing the business actually needs:

> Evidence-backed work: what should change on a website, why, who approved it, what content was produced, where it was delivered, and whether it worked.

This plan introduces a central **Research → Action → Content → Delivery → Outcome** loop.

The engine covers two different kinds of research:

1. **Performance and SEO research** — GSC, GA4, crawl, vitals, keywords, SERP, competitors, backlinks.
2. **AI market research** — Reddit, news, forums, web search, competitor messaging, audience concerns, language, and trends.

Both produce evidence. Both feed the same persisted Action queue.

Apps must stop maintaining separate research prompts and task lists. They provide site context and consume Actions through the API or MCP.

## 2. Core principles

1. **Research produces evidence, not website edits.**
2. **Actions are the central unit of work.**
3. **Content is generated from an Action with selected evidence, never from an unfiltered research dump.**
4. **Delivery is explicit, auditable, and verified.**
5. **Human approval is the default.** Automation is opt-in per site and action type.
6. **Every AI claim must be traceable to stored evidence.**
7. **Research is shared by site/project, not duplicated per app.**
8. **Start inside CrawlSEO.** Do not create a separate research microservice until load or isolation requires it.

## 3. Domain model

```text
SiteProfile
    ↓
ResearchRun ── ResearchSource
    │              │
    └── ResearchFinding
             │
             ▼
        ResearchAction
             │
             ▼
         ContentDraft
             │
             ▼
          Delivery
             │
             ▼
          Outcome
```

### ResearchRun

A single research execution against a site.

Examples:

- Weekly Reddit/news scan for buyer concerns
- Monthly deep topic research
- On-demand competitor investigation
- SEO/DataForSEO report

A run stores the request, source set, model and prompt versions, cost, status, and final report. Reports are immutable snapshots.

### ResearchSource

The actual retrieved evidence:

- provider (`reddit`, `news`, `web`, `competitor`, `youtube`, `dataforseo`, `crawl`)
- URL, title, community/author, publication time, retrieval time
- excerpt and content hash
- language and metadata
- provider payload when useful

Do not store only an AI summary. Store enough source material to verify the report.

### ResearchFinding

A structured insight extracted from one or more sources:

- theme or question
- summary
- finding type: theme, question, concern, objection, trend, misconception, content gap
- confidence
- sentiment or urgency
- source IDs
- freshness
- suggested action type

One finding can produce zero or more Actions.

### ResearchAction

The central work item:

- site and optional research run/finding
- source: `gsc`, `crawl`, `market_research`, `manual`
- kind: create article, update page, add FAQ, rewrite metadata, add section, clarify offer, internal link
- target URL or query
- recommendation and evidence references
- priority
- status
- automation mode
- owner, approval, due date
- delivery and verification timestamps

### ContentDraft

Existing model, extended to link to an Action.

A draft is versioned, reviewable, and never published directly by the research engine.

### Delivery

One auditable application attempt:

- action and draft
- platform (`wix`, `webflow`, `custom`)
- external item ID
- payload or diff
- status
- verification result
- who approved it

## 4. Proposed schema

Names are indicative; implementation may adjust relation names.

```prisma
model SiteProfile {
  id          String   @id @default(cuid())
  siteId      String   @unique
  projectId   String?
  language    String   @default("en")
  country     String?
  audience    Json?
  topics      Json?
  services    Json?
  competitors Json?
  brandVoice  String?
  constraints Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
}

model ResearchRun {
  id             String              @id @default(cuid())
  siteId         String
  projectId      String?
  kind           ResearchRunKind     @default(MARKET)
  trigger        ResearchTrigger     @default(MANUAL)
  status         ResearchRunStatus   @default(QUEUED)
  title          String
  brief          Json
  topics         Json?
  recencyDays    Int                 @default(90)
  providerSet    Json?
  promptVersion  String              @default("research-v1")
  model          String?
  report         Json?
  sourceCount    Int                 @default(0)
  findingCount   Int                 @default(0)
  actionCount    Int                 @default(0)
  costMicros     Int                 @default(0)
  errorCode      String?
  requestedBy    String?
  startedAt      DateTime?
  completedAt    DateTime?
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  site     Site              @relation(fields: [siteId], references: [id], onDelete: Cascade)
  sources  ResearchSource[]
  findings ResearchFinding[]
  actions  ResearchAction[]

  @@index([siteId, createdAt])
  @@index([siteId, status])
  @@index([projectId, createdAt])
}

model ResearchSource {
  id           String   @id @default(cuid())
  runId        String
  provider     String
  url          String
  title        String?
  author       String?
  community    String?
  publishedAt  DateTime?
  retrievedAt  DateTime @default(now())
  excerpt      String?
  contentHash  String?
  language     String?
  metadata     Json?
  createdAt    DateTime @default(now())

  run ResearchRun @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, contentHash])
  @@index([runId, provider])
}

model ResearchFinding {
  id                 String              @id @default(cuid())
  runId              String
  type               ResearchFindingType
  theme              String
  summary            String
  confidence         Int                 @default(50)
  sentiment          String?
  urgency            String?
  evidenceSourceIds  Json?
  suggestedActionKind String?
  createdAt          DateTime            @default(now())

  run     ResearchRun      @relation(fields: [runId], references: [id], onDelete: Cascade)
  actions ResearchAction[]

  @@index([runId, type])
}

model ResearchAction {
  id              String               @id @default(cuid())
  siteId          String
  runId           String?
  findingId       String?
  source          String
  kind            String
  format          String?
  title           String
  primaryQuery    String?
  targetUrl       String?
  recommendation  String
  evidence        Json?
  priority        Int                  @default(50)
  status          ResearchActionStatus @default(PROPOSED)
  automationMode  AutomationMode       @default(MANUAL)
  dedupeKey       String
  owner           String?
  approvedBy      String?
  approvedAt      DateTime?
  deliveredAt     DateTime?
  verifiedAt      DateTime?
  createdAt       DateTime             @default(now())
  updatedAt       DateTime             @updatedAt

  site    Site             @relation(fields: [siteId], references: [id], onDelete: Cascade)
  run     ResearchRun?     @relation(fields: [runId], references: [id], onDelete: SetNull)
  finding ResearchFinding? @relation(fields: [findingId], references: [id], onDelete: SetNull)
  drafts  ContentDraft[]

  @@unique([siteId, dedupeKey])
  @@index([siteId, status, priority])
  @@index([siteId, createdAt])
}

model Delivery {
  id            String   @id @default(cuid())
  actionId      String
  draftId       String?
  platform      String
  externalId    String?
  status        String
  payload       Json?
  diff          Json?
  errorCode     String?
  verifiedAt    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([actionId, createdAt])
}
```

### Enums

```prisma
enum ResearchRunKind { MARKET SEO MIXED }
enum ResearchTrigger { MANUAL SCHEDULED API }
enum ResearchRunStatus { QUEUED RUNNING COMPLETED PARTIAL FAILED }
enum ResearchFindingType { THEME QUESTION CONCERN OBJECTION TREND MISCONCEPTION CONTENT_GAP }
enum ResearchActionStatus {
  PROPOSED
  APPROVED
  DISMISSED
  DRAFTING
  DRAFT_READY
  DELIVERY_APPROVED
  DELIVERING
  DELIVERED
  VERIFIED
  FAILED
}
enum AutomationMode { MANUAL ASSISTED AUTOMATIC }
```

## 5. Research pipeline

### 5.1 Request

The caller supplies context, not a prompt:

```json
{
  "topics": ["Tulum real estate", "property ownership in Mexico"],
  "audience": "international buyers",
  "market": "Mexico",
  "language": "en",
  "questions": [
    "What concerns do buyers repeatedly raise?",
    "What misinformation is common?",
    "What content gaps exist?"
  ],
  "recencyDays": 90,
  "providers": ["reddit", "news", "web"]
}
```

### 5.2 Planning

The AI planner:

- expands topics into source-specific queries
- selects subreddits, news queries, competitor pages, and web searches
- sets per-provider result limits
- refuses to run if the budget is exceeded

### 5.3 Retrieval

Provider adapters return normalized `ResearchSource` candidates:

- Reddit: official API/OAuth where possible; public JSON only where terms permit
- news: GDELT or an approved news API
- web: approved search provider
- competitor pages: fetched HTML, sanitized and hashed
- SEO: existing DataForSEO and first-party evidence

Rules:

- respect robots.txt, provider terms, rate limits, and paywalls
- do not bypass authentication
- store excerpts and links, not full copyrighted pages
- record retrieval time and content hash
- avoid storing unnecessary personal data

### 5.4 Synthesis

The AI produces structured findings with:

- theme
- summary
- source references
- confidence
- freshness
- sentiment/urgency
- suggested action type

Validation:

- every finding must reference at least one stored source
- quoted text must appear in the source excerpt
- a single anecdote cannot be labeled a market trend
- contradictory sources should be surfaced, not averaged away

### 5.5 Action extraction

The engine converts findings into Actions using deterministic rules plus the AI recommendation:

- dedupe by site + kind + target + query
- preserve evidence links
- set priority from impact, confidence, freshness, and effort
- default automation mode from site policy
- never create duplicate open Actions for the same change

## 5A. Existing systems to reuse

Two existing implementations already contain useful research patterns.

### MCP investment brief generator

Files:

- `/REAIupdate/intelligence/generate_investment_brief.py`
- `/MCP/mcp_server/investment_analysis_service.py`

Reusable ideas:

- Google Search grounding with a verified source register
- source typing (`official_primary`, `government`, `court`, `developer`, `reputable_secondary`, etc.)
- rejection of untrusted hosts for official claims
- explicit handling of adverse claims
- source redirect resolution before trust checks
- contradiction and unsupported-claim sanitization
- source-fingerprinted cache with writer version
- hard quality gate that rejects an empty or source-only brief

This is the right model for **high-stakes factual claims**, not for general sentiment.

### site-agent incubation research

Files:

- `/SOCIAL/site-agent/src/site_agent/brain/incubation_research.py`
- `/SOCIAL/site-agent/src/site_agent/application/incubation_research.py`
- `/SOCIAL/site-agent/src/site_agent/hands/feed_discovery.py`
- `/SOCIAL/site-agent/src/site_agent/brain/article_research.py`
- `/SOCIAL/site-agent/docs/ada-incubation-research-and-provisioning-implementation-plan.md`

Reusable ideas:

- research planning from an intake/site profile
- candidate subreddit/feed/query discovery
- bounded source and item limits
- source trust states: candidate, allowed, excluded
- owner exclusions and per-revision research caps
- findings and insights with confidence and provenance
- audience concern / desire / trend / content opportunity classification
- research used to inform design and content without becoming owner-confirmed fact

This is the right model for **audience and market intelligence**.

### Combined approach

Use the site-agent planner and synthesis model for market research, and the
investment-brief evidence gate for factual claims.

```text
Site profile / incubation draft
  -> AI research planner
  -> source discovery
  -> bounded retrieval
  -> evidence validation by claim type
  -> findings
  -> actions
  -> content briefs
```

#### Claim-type source policy

| Claim type | Allowed evidence |
|---|---|
| Audience concerns, language, desires, objections | Reddit, forums, news, web; labelled as signal |
| Content gaps and recurring questions | Reddit, forums, news, web |
| Market trends | Multiple reputable sources; require recency and source count |
| Prices, yields, legal ownership, taxes, medical/financial advice | Official primary sources only |
| Developer, HOA, litigation, safety, misconduct claims | Official primary/court/regulatory only; social posts are not evidence |
| SEO performance | GSC, GA4, crawl, DataForSEO |

Reddit is valuable for **what people are saying**, not for proving **what is true**.

## 5B. Reddit provider and bot

Reddit RSS is not a durable production dependency. `site-agent` currently turns
subreddit candidates into `.rss` URLs in `RedditFeedDiscovery`; that adapter
must be replaced.

### Recommended access path

Use the official Reddit Data API with OAuth and a dedicated read-only bot
account/application.

- App type: script or confidential client
- Bot identity: a dedicated service account, not a personal account
- Scopes: read-only (`read`, plus the minimum identity/history scope required)
- Token storage: encrypted secret store, never in the database or logs
- No posting, voting, commenting, messaging, or moderation in v1
- Respect subreddit rules, Reddit API terms, rate limits, and deletion semantics

### Provider contract

```ts
interface RedditResearchProvider {
  searchSubreddits(query: string, limit: number): Promise<SubredditCandidate[]>;
  searchPosts(input: {
    subreddit?: string;
    query: string;
    sort: "relevance" | "new" | "top";
    timeWindow: "week" | "month" | "year" | "all";
    limit: number;
  }): Promise<RedditPost[]>;
  getThread(postId: string, commentLimit: number): Promise<RedditThread>;
}
```

### Stored fields

- Reddit fullname (`t3_...`) and permalink
- subreddit and language
- title, selftext excerpt, and selected top comments
- publication time and retrieval time
- score and comment count
- content hash
- trust state and relevance
- source URL and citation URI

Store excerpts and links, not full thread dumps. If a post is deleted or removed,
mark the stored source unavailable rather than pretending the evidence still
exists.

### Operational controls

- per-run request budget
- global rate limiter and exponential backoff
- `429` handling with retry windows
- per-subreddit and per-query caps
- deduplication by Reddit fullname and content hash
- user-agent and contact metadata
- audit log of every retrieval attempt
- no credentials in prompts, findings, or client bundles

### RSS policy

RSS remains supported for publisher blogs and news feeds, but not as the
primary Reddit path. Reddit-specific discovery must not generate `.rss` URLs.

## 5C. Reddit RSS interim phase

Before building the Reddit OAuth bot, use Reddit's public search RSS as a
bounded interim provider.

Endpoint:

```text
https://www.reddit.com/search.rss?q=<query>&type=link&sort=relevance&t=year&limit=25
```

Notes:

- `type=link` is required; without it Reddit returns subreddit results.
- Parse Atom entries and store title, URL, author, subreddit, published time,
  excerpt, and content hash.
- RSS does not reliably provide comments, scores, or full thread context.
- Respect rate limits and use a descriptive User-Agent.
- Treat RSS as a temporary adapter behind the same provider interface that the
  bot will implement later.
- Do not store RSS feed URLs as the canonical source URL; store the Reddit post
  permalink.

The bot replaces the transport, not the research pipeline.

## 5D. Unified signal and action model

Keyword research and SEO opportunities are not separate content pipelines.
They are inputs to the same Action.

```text
Market research finding
  "Buyers repeatedly ask how foreign ownership works"

Keyword research evidence
  "can foreigners own property in mexico" — demand, intent, difficulty

SEO opportunity evidence
  Page ranks #12, low CTR, missing FAQ, no canonical

                    ↓ merge by topic / query / target URL

Action
  "Add an ownership FAQ to this page and update its metadata"

                    ↓

Content brief
  Audience language + keyword intent + SERP expectations + page facts

                    ↓

ContentDraft → review → delivery → outcome
```

### Signal types

- `market_research` — Reddit/news/web findings
- `keyword_research` — DataForSEO/volume/SERP evidence
- `gsc_opportunity` — striking distance, CTR gap, decay, cannibalization
- `crawl_issue` — page-level technical/content evidence
- `analytics` — GA4 behaviour/conversion evidence
- `manual` — operator instruction

### Action merging rules

1. Same target URL + same query/topic merges into one Action.
2. Market research without demand can still create an Action, but lower priority.
3. Keyword demand without audience insight can create an Action, but content is
   more likely to be generic.
4. A page update is preferred when a relevant URL already exists.
5. A new article is preferred when no page satisfies the intent.
6. Actions must preserve all evidence, not only the winning signal.
7. One Action can link to multiple findings, keyword rows, GSC opportunities,
   crawl issues, and sources.

### Action evidence shape

```json
{
  "market_findings": [],
  "keyword_evidence": {
    "seed": "...",
    "volume": 0,
    "difficulty": 0,
    "intent": "...",
    "serp_features": []
  },
  "gsc_evidence": {
    "query": "...",
    "page": "...",
    "position": 0,
    "impressions": 0,
    "ctr": 0
  },
  "page_evidence": {
    "url": "...",
    "title": "...",
    "word_count": 0,
    "issues": []
  },
  "citations": []
}
```

### Priority model

Priority should combine:

- demand (volume, impressions, clicks)
- business relevance
- evidence confidence and source count
- freshness
- page/content gap
- conversion or decision intent
- effort

No single signal decides. The SEO opportunity tells us where the site can win.
The market research tells us what the audience actually needs. Keyword research
quantifies the demand. The page/crawl evidence tells us what to change.

### UI implication

The Research & Actions queue should show:

- what triggered the Action
- all supporting signals
- whether demand is proven, inferred, or absent
- the target page or query
- whether it is a page update, article, FAQ, or metadata change
- what content brief will be generated

Keyword Research and Opportunities remain useful exploration screens, but their
outputs must be attachable to Actions rather than ending as isolated tables.

## 6. Action lifecycle

```text
PROPOSED
  ├─ APPROVED → DRAFTING → DRAFT_READY → DELIVERY_APPROVED → DELIVERING → DELIVERED → VERIFIED
  ├─ DISMISSED
  └─ FAILED
```

Manual actions can start at `APPROVED`.
Automatic metadata actions may skip human approval if policy allows, but still require delivery verification.

## 7. Content engine

Generation is triggered by an Action.

Inputs:

- Action and recommendation
- SiteProfile and brand voice
- selected evidence only
- target platform constraints
- format: metadata, page update, article, FAQ, section

Outputs:

- versioned ContentDraft
- validation result
- review status
- delivery-ready payload

Content Studio becomes the review and approval surface. It is no longer the strategy origin.

## 8. Delivery engine

Provider adapters implement a common interface:

```ts
interface DeliveryAdapter {
  supports(target: ContentTarget): boolean;
  deliver(input: DeliveryInput): Promise<DeliveryResult>;
  verify(result: DeliveryResult): Promise<VerificationResult>;
}
```

Initial adapters:

1. Manual export
2. Wix CMS/Blog
3. Webflow

Every delivery records payload, diff, external ID, status, and verification.

## 9. API and MCP

API surface:

```text
POST   /api/sites/:siteId/research/runs
GET    /api/sites/:siteId/research/runs
GET    /api/research/runs/:runId
POST   /api/research/runs/:runId/findings
GET    /api/sites/:siteId/actions
PATCH  /api/actions/:actionId
POST   /api/actions/:actionId/draft
POST   /api/actions/:actionId/delivery
```

MCP equivalents:

```text
create_research_run
get_research_run
list_research_findings
list_actions
approve_action
generate_content
deliver_content
get_delivery_status
```

Project-scoped service credentials and existing scopes should be reused.

## 10. Scheduling

Cheap monitoring:

- daily GSC/GA4
- stale crawl refresh
- weekly vitals
- alert evaluation

Research:

- weekly light market scan per active site
- monthly deep research per project
- on-demand API/MCP run

Content:

- event-driven from approved Actions
- optional auto-draft for low-risk action types

Cost controls:

- per-run provider/task budget
- per-project monthly budget
- cache by site, topic, source window, prompt version, and model
- refuse or defer when budget is exhausted

## 11. UI

Central views:

### Portfolio
- sites with open Actions
- blocked/failed research
- drafts awaiting review
- deliveries awaiting verification
- automation mode

### Site workspace
- Research runs and reports
- Findings with source links
- Action queue
- Content drafts
- Delivery history
- Outcome tracking

### Work queue
Filters:

- site
- source
- status
- owner
- automation mode
- platform
- due date

The queue must make it obvious:

- what needs human action
- what is being generated
- what was delivered automatically
- what failed and why

## 12. Rollout

### Phase 1 — Foundation

- Add SiteProfile, ResearchRun, ResearchSource, ResearchFinding, ResearchAction.
- Link ContentDraft to ResearchAction.
- Add service layer and API endpoints.
- Add a read/write Research and Action UI.
- Add validation tests.

### Phase 2 — AI market research worker

- Add provider abstraction.
- Implement Reddit and news providers.
- Add AI query planning and synthesis.
- Persist citations and findings.
- Generate Actions from findings.
- Run a pilot for Casamigo.

### Phase 3 — Content Studio integration

- Generate drafts from Actions.
- Add approval and automation policy.
- Add action-to-draft versioning.

### Phase 4 — Delivery and outcomes

- Add delivery adapters.
- Add verification.
- Add post-delivery GSC/GA4 outcome tracking.
- Expose full workflow through API and MCP.

## 13. Acceptance criteria for Phase 1

- A research run can be created for a site and persisted.
- Sources and findings can be attached to a run.
- Findings can produce deduplicated Actions.
- Actions have status, priority, evidence, and automation mode.
- Content drafts can link to an Action.
- The UI lists research runs, findings, and Actions.
- All site access remains behind authentication.
- Build, typecheck, lint, and tests pass.
- Migration applies cleanly.

## 14. Open decisions

1. Reddit access path: official OAuth app vs approved third-party provider.
2. News provider: GDELT first vs paid news API.
3. Whether market research scheduling is weekly or monthly by default.
4. Whether low-risk metadata Actions may auto-deliver in Phase 1 or require approval.
5. Whether SiteProfile is owned entirely by CrawlSEO or apps may push partial context.

## 15. Immediate implementation in this branch

Phase 1 is implemented:

- schema and migration
- validation and service layer
- API endpoints for research runs, findings, and actions
- ContentDraft linkage
- Research/Actions UI
- tests

Phase 1.5 starts next:

- provider interface
- Reddit RSS provider (`search.rss?type=link`)
- news and web provider adapters
- claim-type source policy
- AI planner and synthesizer worker
- persist keyword and GSC evidence into the same Action queue

Phase 2 replaces the Reddit RSS transport with the read-only OAuth bot.

The content and delivery phases follow after research output is stable.

## 16. Implementation status

Updated: 2026-10-23

Implemented:

- central `ResearchRun`, `ResearchSource`, `ResearchFinding`, `ResearchAction`, and `Delivery` schema
- Research & Actions UI with run creation, status polling, approve/dismiss, and draft actions
- durable research-job worker
- Reddit RSS interim provider (`search.rss?type=link`)
- Google News RSS provider
- evidence-grounded AI synthesis into findings and proposed Actions
- SEO/GSC/crawl opportunity persistence into the same Action queue
- keyword research evidence attachment and merge into existing query Actions
- Action-to-ContentDraft generation through Content Studio
- agent-task handoff for embed/page implementation with repo, route, evidence, guardrails, diff/build/bridge-plan requirements
- Wix Blog detection that keeps blog targets on the Blog API path instead of the embed agent path
- daily GSC/GA4/crawl/vitals sync
- daily SEO opportunity persistence

Still pending:

- Reddit OAuth bot to replace Reddit RSS
- general web search provider
- claim-type policy enforcement beyond prompt instructions
- Wix Blog draft/update adapter
- Wix embed delivery adapter using the existing bridge
- agent-task executor integration (worktree creation, OpenCode run, diff/build capture)
- post-delivery outcome tracking
- automation policy and auto-delivery controls
