# Intelligence UI experience audit

Date: 2026-10-27. Scope: CrawlSEO dashboard (`/SEO`) and the HelloAda website room (`/SOCIAL/helloada`).
Evidence: production pages rendered from `https://crawlseo.helloada.app/crawlseo` for
`www.susimacdonald.com` (`cmrxqmohr0005oyk6vm88zy65`), plus row counts read from the production
database on the app host.

## Verdict

The intelligence backend is largely built and producing data. The dashboard does not present it.
The only place that claims to be an intelligence surface is `/sites/[siteId]/intelligence`, which is
not linked from the sidebar and renders long text blocks with repeated "unknown (not recorded)"
labels. Everywhere else the user sees either a raw search box or an empty state that tells them to
configure something the platform already has.

## What the database holds

| Record | Rows | Notes |
| --- | --- | --- |
| `Keyword` (GSC) | 44,704 | Surfaced on Keywords / Opportunities / Content Studio |
| `ResearchAction` | 293 | 155 for Susi; AEO and GEO dimensions are 0 |
| `ArticleKeywordResearchRun` | 24 completed, 2 failed | Real DataForSEO results, five sites, never rendered |
| `ResearchRun` | 7 | Rendered on `/research` and run detail |
| `ResearchSource` / `ResearchFinding` | 127 / 39 | Rendered inside a run, not aggregated |
| `SiteProfile` | 4 | Audience, topics, constraints; no UI |
| `BusinessKnowledgeDocument` | 1 | Test project only; real sites show "unavailable" |
| `AIVisibilityObservation` | 6 | Test project fixture only |
| `QuestionCoverage` | 4 | Test project only |
| `CrawlIssue` | 5,425 | Surfaced as technical Actions |

## Surface-by-surface gaps

### 1. Keyword research results are invisible

- `/keyword-research` is an empty search box (`components/research/keyword-research-client.tsx`).
- The API (`app/api/sites/[siteId]/keyword-research/route.ts`) only replays a legacy
  `SeoResearchRun.report` for the project and otherwise falls back to Google Autocomplete.
- The page gate (`app/(dashboard)/sites/[siteId]/keyword-research/page.tsx`) checks the legacy
  per-user `ApiKey` table, so it prints "Add a DataForSEO API key in Settings" even though the
  platform credential is active and paid research has run. The modern path is
  `ProjectApiKeyGrant` → `ProviderCredential` (`lib/dataforseo/client.ts`,
  `lib/dataforseo/platform-credentials.ts`).
- `ArticleKeywordResearchRun` stores volume, difficulty, CPC, competition, intent and a 24-month
  trend per keyword. No page or component reads the table: `grep articleKeywordResearchRun app components`
  returns nothing. Twenty-four completed runs are therefore dead data.

### 2. Business data has no home

- `SiteProfile` (audience, topics, services, competitors, brand voice, constraints) is written by
  research and connector flows and read only to build prompts.
- `BusinessKnowledgeDocument` is read only by `/intelligence`, which for every real site reports
  "Business profile unavailable — no canonical business knowledge document is recorded".
- Research configuration is the closest thing to a business view and shows four flat facts
  (topics, audience, market, providers).
- There is no page that answers "what does CrawlSEO believe about this business, where did each fact
  come from, and how do I correct it".

### 3. AEO/GEO has no surface

- The Work dimension filter exposes AEO (0) and GEO (0) next to SEO (43) and CONTENT (49), which is
  what the user described as "an intelligence filter that shows no interesting information".
- `/intelligence` has three static access cards (robots, sitemap, reachability), an empty
  "Visibility observed" block and an empty "Questions" block for real sites.
- Structured data and identity signals exist only as individual crawl Actions
  (`fix_business_identity_jsonld`, `No Structured Data — 46 pages`), never as an AEO overview.
- `AIVisibilityObservation` and `QuestionCoverage` are rendered only when rows exist, and the only
  rows belong to the `example.com` fixture project, so the blocks are always empty in practice.

### 4. Navigation hides the work

`components/layout/sidebar-nav.tsx` links Overview, Work, Keywords, Saved Keywords, Pages,
Crawl/Audit, Vitals, Alerts, Research, Keyword Research, Domain Overview, Backlinks, AI & MCP,
Settings. Missing: Intelligence, Content Studio, Opportunities, Actions. Three built surfaces are
reachable only by typing the URL or following a link inside another page.

### 5. Presentation is a text dump

- `/intelligence` renders 100+ action rows, each with `dimension`, `origin gap unknown (not recorded)`
  and `verifier unknown (not recorded)`, with no grouping, counts or filters.
- The prelaunch report (`/projects/[projectId]/prelaunch/[runId]`) renders keyword results as
  `<li>keyword · volume · difficulty · intent</li>` lines, with no table, sort or export.
- Research sources are one flat list of titles and timestamps.
- The site switcher shows the raw cuid (`cmrxqmohr0005oyk6vm88zy65`) instead of the domain, because
  `SelectValue` has no children and Base UI falls back to the value.

### 6. HelloAda inherits nothing

`/SOCIAL/helloada` `src/app/websites/[id]/page.tsx` and `room.tsx` show phase, bootstrap progress,
chat and design recommendations. There is no business profile, research result, keyword set or
AEO/GEO readout for the website, and no link to its CrawlSEO project. A HelloAda owner therefore
cannot see any of the intelligence that CrawlSEO holds for their site.

## Root causes

1. Two DataForSEO credential models coexist; the UI gates on the retired per-user one.
2. Data was added for contracts and verification (UI-003/UI-010/UI-011) without an owning surface.
3. `ArticleKeywordResearchRun` was built for the article pipeline and never given a read surface.
4. The Intelligence page accumulated sections by issue rather than by user task, and was never
   linked from navigation, so no one noticed it reads as a compliance log.
5. Empty states explain what is missing but not what exists elsewhere, so a site with 44k keywords
   and 24 paid research runs still looks empty.
