# Research and business context → opportunities: implementation plan

**Status: implementation plan for a coding agent. 2026-11-21.**
Parent requirements: [product operating model](crawlseo-product-operating-model.md).
Read this with the root `AGENTS.md` ("AI owns context; code owns facts",
"No silent truncation", "Universality is non-negotiable") before writing code.

## Goal

Opportunities on the board should be specific to the business and backed by
measured demand: a real query with volume and position, a sourced reason, and a
page verdict. Today the loop is broken in two places:

1. **Business knowledge is optional at run time.** `extractBusinessKnowledgeFromSite`
   is called only from `ensureTenantAnalysis`, which only the monthly cycle and a
   CLI call. The research runner never calls it, and the synthesizer prompt
   (`lib/research/synthesizer.ts`) receives topics, goals, audience and market,
   but not the knowledge fields. A priced research run therefore produces
   findings that could have been written for any site in the market.
2. **Research output never becomes keyword research input.** `buildBundlePlan`
   (`lib/research/monthly-bundle.ts`) builds its candidate pool from GSC ranks and
   previously measured queries only. Findings reach the funnel as
   `research_finding` evidence (`lib/research/finding-evidence.ts`), and one
   phrase per opportunity is measured later by the join runner
   (`lib/funnel/join-runner.ts`), but pain points, questions and the wording
   buyers use never enter the paid keyword/SERP plan.

Everything else — the bundle, the taxonomy gate, the evidence spine, the
proposal model — stays. This plan adds three small things and one scheduler, and
deletes duplicated reads as it goes.

## Design

Three objects, one cycle. Nothing else is added.

```
                    ┌──────────────────────────────┐
   crawl + pages ──▶ │ business knowledge (existing) │◀── research facts (M4)
                    └──────────────┬───────────────┘
                                   │  SiteBrief: one read, every AI call (M2)
             ┌─────────────────────┼──────────────────────┐
             ▼                     ▼                      ▼
      research synthesis     discovery seeds        topic map / critic
             │
             │ demand forms (M3): the phrases buyers type
             ▼
   evidence: research_finding(query, demandQueries)
             │
             ▼
   bundle candidate pool  =  GSC ranks ∪ measured ∪ research forms
             │                     (taxonomy-gated, unmeasured first)
             ▼
   DataForSEO measurement ──▶ topic map ──▶ opportunities (why + how legs)
             │
             └── measurement writes back onto the finding (M3)
```

- **SiteBrief** (`lib/site/brief.ts`, new, ~60 lines): the single read of
  `resolveSiteContext` + business knowledge fields (publication-use filtered) +
  profile topics/audience + policy goals. Every model call that makes a business
  judgement takes it. No prompt assembles these fields inline again.
- **Demand forms** (schema + prompt + one reader): a finding carries the short
  phrases a buyer would type. `ResearchFinding.demandQueries` is one array
  column; the bridge copies them into evidence dimensions; one reader
  (`lib/research/demand-candidates.ts`) returns them to the bundle and the join
  runner. No candidate table, no candidate pipeline.
- **Site cycle** (`lib/jobs/site-cycle.ts`, new): the existing monthly cycle
  grows into an ordered, idempotent, resumable stage runner that also owns the
  weekly sweep and the monthly bundle. Scripts stay as one-site wrappers.

## Invariants (review checklist for every milestone)

1. **No per-tenant shape.** No tenant id, domain, city, path or language in
   `lib/`. Only identity, isolation and externally issued mappings are per
   tenant; cadence is a declared policy, read identically for every site.
2. **The model decides meaning; code computes facts.** The model proposes demand
   forms, seed phrases and knowledge values. Code validates shape, dedupes,
   counts, orders and stores. No plural/word-order/synonym expansion in code.
3. **No deterministic fallback for a semantic field.** If the model returns
   nothing usable, the run reports it and the reader shows nothing; it does not
   guess. Existing fallbacks (e.g. `fallbackSeeds`) stay as they are and keep
   reporting `source: "fallback"`; no new ones are added.
4. **No silent truncation.** Every cap is a named constant and its dropped count
   is reported in the run report or bundle `coverage`.
5. **Prove on a disposable tenant, never a customer.** Behaviour-changing
   milestones (M3, M4) run there first, then the fleet mechanism.
6. **One reader, many callers.** If two places need the same query, it is one
   exported function. A second copy is a bug.

## Milestones

Each milestone is independently shippable and reversible. Size is relative:
**S** ≤ 1 day, **M** 2–3 days, **L** ~1 week including tests.

### M0 — Baseline, measured before changing anything (S)

**Change.** Add `scripts/context-baseline.ts`: read-only report per site of
knowledge document (absent / unusable / working / accepted), last research run
and its findings, `research_finding` evidence count, opportunities and how many
carry a measured query (`keyword_metrics` or `keyword_rank` for their query),
last bundle month. JSON and a one-line-per-site table. No writes, no model calls.

**Why.** The brief says knowledge "is still absent for a lot of tenants". This
turns that into a number and gives every later milestone a before/after.

**Verification.**
- `npx tsx scripts/context-baseline.ts --all` exits 0 and prints every active
  site (`retiredAt: null`, `projectId` set) — count matches
  `SELECT count(*) FROM "Site" WHERE "retiredAt" IS NULL`.
- Re-running produces identical output (pure read).
- Record the output in the PR description. No production table is written.

---

### M1 — Business knowledge is always present before a run (M)

**Change.**
1. In `lib/projects/business-knowledge-extract.ts`, build the page set from the
   latest completed crawl first: `auditPage.contentText` for the same inventory
   sample the synthesizer already uses (`buildPageInventory`, one sample per page
   type), then sitemap sections the crawl missed, then the root. Network fetch
   only fills gaps. Return `pagesFromCrawl`, `pagesFetched`, `pagesUnreadable`
   in the result so the report says which source it read.
2. Add `ensureBusinessKnowledge(db, { siteId, projectId })` next to the
   extractor: returns the existing document when usable, otherwise extracts once
   and throws `BUSINESS_KNOWLEDGE_MISSING: <reason>` when the extractor produced
   nothing. "Usable" is the existing `hasUsableKnowledgeFields` predicate — reuse
   it, do not re-implement it.
3. Call it at the start of `runResearchRun` (`lib/research/runner.ts`) and in the
   cycle's knowledge stage. The monthly cycle's bootstrap
   (`ensureTenantAnalysis`) keeps calling it; no new job kind.

**Why.** Extraction currently refetches the open web, which is exactly what
fails on WAF-protected sites, and it is not on the research path at all.

**Verification.**
- New test `tests/business-knowledge-crawl-source.test.ts`: fixture DB with a
  completed crawl and `contentText`, knowledge missing, `fetch` stubbed to fail
  → extraction succeeds, zero fetches, fields attributed to the page that
  contains them.
- Same fixture without a crawl → falls back to fetching, and the result reports
  `pagesFromCrawl: 0`.
- `npx tsx scripts/tenant.ts --all` (read-only) before and after: the number of
  `business-knowledge missing` steps drops for every site that has a completed
  crawl; any remaining `failed` step names the extraction error.
- A research run on a site with no knowledge document now fails with
  `BUSINESS_KNOWLEDGE_MISSING` in `errorCode` instead of completing PARTIAL with
  thin findings.

**Out of scope.** No re-extraction when a usable document exists. No scheduled
knowledge refresh; that is M4's review loop plus the owner accepting a revision.

---

### M2 — One SiteBrief for every model call (S)

**Change.** Add `lib/site/brief.ts`:

```ts
export type SiteBrief = {
  siteId: string; domain: string; language: string;
  market: string | null; audienceMarket: string | null;
  audience: string | null; topics: string[]; goals: string[];
  // Only publicationUse !== "prohibited"; each fact carries provenance.status.
  facts: Array<{ field: string; value: string; status: string; sourceUrl: string | null }>;
};
export async function buildSiteBrief(db, siteId): Promise<SiteBrief>;
```

Pass it to `synthesizeResearch` (replace the loose `siteDomain/topics/goals/...`
parameters with `brief` plus the run-specific fields), to
`synthesizeTopicMap`, to `proposeDiscoverySeeds` (it already receives most of
these, now from one source), and to `critiqueProposals`.

Prompt rule to add in the synthesizer: facts with status `assumed` or `advised`
may shape a hypothesis but must not be stated as confirmed business fact.

**Why.** One read, one shape, one place to fix. Today each caller re-derives a
subset, which is how the knowledge fields got dropped from synthesis.

**Verification.**
- `grep -rn "businessKnowledgeFields(" lib app scripts` returns only
  `lib/site/context.ts` (the brief's resolver), `lib/site/brief.ts` and
  `lib/recommendation/packet.ts` (the packet deliberately keeps provenance for
  citations; do not change it in this milestone).
- New test `tests/research-synthesis-brief.test.ts`: a brief with a
  `differentiators` fact appears in the prompt; a `publicationUse: "prohibited"`
  fact does not.
- The topic map and the synthesizer produce the same taxonomy/findings as before
  on a fixture site **except** for the added facts; assert no other prompt line
  changed (snapshot the prompt).

---

### M3 — Research demand forms enter paid keyword research (M)

**Change.**
1. Schema: `ResearchFinding.demandQueries String[] @default([])` (additive
   migration). Synthesizer contract adds
   `demand_queries: ["…"]` per finding: 0–5 short phrases in the market's
   language, the forms buyers actually type (including question and plural
   forms), never a sentence, no numbers or invented metrics. Shape validation
   only: trim, dedupe, ≤ 70 chars, ≤ 5; report `demand_queries_dropped` in the
   run report.
2. Persist through `createResearchFinding`; copy into `research_finding` evidence
   dimensions in `lib/research/finding-evidence.ts`.
3. New `lib/research/demand-candidates.ts`:
   `researchCandidateQueries(db, { projectId, siteId, since, taxonomy, limit })`
   reads `research_finding` evidence newer than `since` (named constant,
   default 120 days), returns phrases with their source finding, deduped by
   normalized phrase, taxonomy-gated, unmeasured first. Counts what it dropped.
4. `buildBundlePlan`: candidate pool becomes
   `in-market GSC ∪ in-market research candidates ∪ off-topic GSC`. Extend
   `coverage` with `researchCandidateQueries`, `researchCandidatesUnmeasured`,
   `researchCandidatesOmitted`. Cap and cost estimate unchanged.
5. `queryForOpportunity` in the join runner prefers `dims.query`, then the first
   `dims.demandQueries` entry — same collector, no new measurement path.
6. **Cold start:** when no taxonomy is approved, research candidates are not
   bought; they are counted as `researchCandidatesUnclaimed`. Month 1 uses
   discovery seeds (business knowledge) → measured queries → topic map →
   taxonomy; month 2 admits research candidates. This is ordering, not a special
   case in code.

**Why.** This is the loop the product is for: research sees a need in the
buyer's words, DataForSEO answers whether it is a real, winnable query.

**Verification.**
- `tests/bundle-research-candidates.test.ts`:
  - a finding whose form is in-market and unmeasured appears in
    `selected.keywordQueries`;
  - an off-topic form does not, and is counted in `coverage.researchCandidatesOmitted`;
  - `coverage.researchCandidateQueries === selected + omitted`;
  - `estimatedMicros` for a fixture plan is unchanged versus the pre-change
    snapshot (the cap decides spend, not the candidate pool).
- `tests/join-query-selection.test.ts`: an opportunity whose only evidence is a
  finding with `demandQueries: []` skips with a reason; one with a form measures
  that form.
- `npx tsx scripts/research-bundle.ts --site <disposable> --month <current> --dry-run`
  shows the research candidates in the plan and the new coverage numbers, with
  no paid call.

**Reject if.** The change adds a table, a `ResearchRun` kind, or a second
candidate-selection function.

---

### M4 — Research proposes knowledge updates, the owner keeps authority (M)

**Change.** After `bridgeFindingsToEvidence` in `runResearchRun`, call
`proposeKnowledgeFromResearch(db, { projectId, siteId, runId })`:
one model call over the run's findings and the current fields, returning only
fields the findings support, each with source indexes. Write through the existing
`writeBusinessKnowledge` with an internal principal (`research-bridge`,
`document:write`), provenance `research_observation` / status `advised` /
`publicationUse: "internal_only"` / `evidenceUri` = the cited source URL.
Rules enforced in code (facts, not judgement):

- skip a field whose current provenance status is `owner_confirmed`,
  `admin_confirmed` or `verified`; report `skippedConfirmed`;
- write only when a value actually changed (normalized string compare); report
  `unchanged`;
- one write per run, idempotency key `research-bridge:<runId>`.

Report `{ proposed, skippedConfirmed, unchanged, rejected }` under
`synthesis.knowledge` in the run report.

**Why.** This is "research feeds knowledge" without letting one thread overwrite
a confirmed fact, and it reuses the write path, the provenance enum and the
business page that already renders `kind · status`.

**Verification.**
- `tests/research-knowledge-proposal.test.ts`: a confirmed field is untouched and
  reported as skipped; an unconfirmed field is written with
  `research_observation`/`advised`; a re-run with identical findings writes
  nothing and reports `unchanged`.
- `tests/research-knowledge-proposal.test.ts` also asserts `publicationUse` is
  `internal_only` for every written fact.
- Manually: the site's Business page lists the new fields with
  `research_observation · advised (unconfirmed)`.
- The next run's `SiteBrief` includes them (M2 test extension).

---

### M5 — One automatic cycle: daily, weekly, monthly (L)

**Change.** `lib/jobs/site-cycle.ts` with `runSiteCycle(db, { now, siteIds, dryRun })`.
Stages, each keyed `cycle:<site>:<period>:<stage>` and each a call to a function
that already exists:

| Cadence | Stage | Function | Paid |
|---|---|---|---|
| daily | knowledge presence / staleness, retry failed runs | `ensureBusinessKnowledge`, queue retry | no |
| weekly | crawl | existing job | no |
| weekly | GSC/GA4 | existing job | no |
| weekly | news + timely | `runWeeklyRefresh` | no |
| weekly | research run | `createResearchRun` + `RESEARCH_RUN` job | no (news/community only) |
| monthly | knowledge before research | M1 | no |
| monthly | DataForSEO bundle | `runMonthlyBundle` behind a new `JobKind.BUNDLE` | yes |
| monthly | topic map | existing `synthesizeTopicMap` + `storeTopicMap` | no |
| monthly | opportunities + measurement | existing detectors + `runJoinFollowUps` | bounded |

Rules:

- A stage whose dependency has not completed reports `blocked` with the
  dependency name; it is retried on the next tick, never silently skipped.
- The monthly bundle's dependency is "this month's research run is COMPLETED or
  PARTIAL", or "research disabled by the owner". That is the only exception and
  it is a declared policy state, not an inferred one.
- One new enum value (`JobKind.BUNDLE`) and its worker handler. Weekly stages run
  inline like `runMonthlyCycle` does today; heavy async stages stay Jobs.
- `scripts/monthly-cycle.ts`, `research-weekly.ts`, `research-bundle.ts` become
  thin `--site` wrappers over the same functions. `scripts/sync-research.ts`
  (and its `sync:research` npm entry) is retired once the cycle creates research
  runs for every site; if a host cron still calls it, make it a one-site wrapper
  instead of keeping a second scheduler.

**Why.** Only the monthly research run is automatic. The bundle — the actual
keyword research — and the weekly sweep are scripts someone must remember.

**Verification.**
- `npx tsx scripts/monthly-cycle.ts --dry-run --site <disposable>` prints the
  stages in dependency order with `would queue` / `blocked: <dependency>`.
- Running the cycle twice for the same day queues nothing new (idempotency keys).
- Killing the worker between the research stage and the bundle resumes at the
  bundle; no duplicate run, no second paid plan.
- A site with research disabled: bundle runs from GSC only and the stage detail
  says so. A site with missing knowledge: research is `blocked`, never a thin run.
- Existing flags still work: `research-bundle.ts --site X --month Y --dry-run`
  and `--execute --approval`.
- `npm test` green; worker log has one line per site per stage.

---

### M6 — Make the loop visible in the UI (S/M)

**Change.** No new route, no new table.

1. Opportunity detail ("Why this exists" / "Search evidence"):
   - the search leg names the measured query with volume and position, or says
     "unmeasured" with the reason (already the pattern; assert it holds for
     research-led opportunities);
   - the business leg shows the finding's source title and URL, not only
     "research_finding".
2. Demand page: one read-only block "Suggested by research — not yet measured"
   over `researchCandidateQueries`, each row: phrase, source finding, source URL,
   and whether it is claimed by a topic. Uses the M3 reader; no new query logic.
3. Business page: group fields by `provenance.kind` so research-proposed facts
   are visible as a set (the page already renders status per field).

**Why.** The end goal is the board showing better opportunities. If the user
cannot see why an opportunity exists, the loop is unverifiable from the product.

**Verification.**
- On the disposable tenant: an opportunity created from a research finding shows
  both legs populated and the measured query; a screenshot in the PR.
- The research block lists the same phrases as the bundle plan for that month
  (compare against `--dry-run` output).
- Server component query count does not grow with the number of opportunities
  (assert with a query counter in the existing page test, or a Prisma
  `$on('query')` count in a focused test).
- No layout regression at 390px (screenshot); `npm run lint` and `npm test` green.

## Anti-bandaid rules

A change is rejected if any of these is true.

- It special-cases a tenant, domain, language, city, page path or business model.
  The new-tenant test is: a French service business, no GSC history, no
  knowledge, no crawl — the code path must not change, and the output must be an
  honest "not yet known" rather than a guess.
- It adds a deterministic helper for a semantic decision (owner page, need term,
  plural, word order, synonym, page type, offer match). Ask "is this a fact or a
  judgement?" A judgement goes in the prompt or in a contract rejection.
- It hides a cap. Every bound is named and every drop is counted.
- It fixes a prompt symptom by adding an `if` in code that is not a fact. Prefer
  rejecting the model output and re-proposing once, with the reason.
- It makes a second copy of an existing read. Reuse `hasUsableKnowledgeFields`,
  `buildPageInventory`, `queryMatchesTaxonomy`, `storeEvidenceRecord`,
  `writeBusinessKnowledge`, `runJoinFollowUps`.
- It proves a fix only on a customer. Behaviour changes go to a disposable tenant
  first, then the fleet mechanism once.

## Overengineering budget — what this plan refuses to add

- **No candidate table or candidate pipeline.** One array column, one evidence
  dimension, one reader.
- **No new run type or knowledge job.** Research runs and the tenant bootstrap
  already exist; the cycle orders them.
- **No generic provider framework.** The existing provider functions and
  `ResearchProviderSource` are enough; a new provider is a function, not a
  registry.
- **No event bus, no stage framework, no DSL.** `runSiteCycle` is a list of
  function calls with dependency names, like `runMonthlyCycle` is today.
- **No review-queue table for knowledge.** Provenance status `advised` on the
  working revision is the queue; the business page is the screen.
- **No confidence scoring invented in code.** The model's confidence travels as
  data.
- **No new prompt files or prompt registry.** Prompts stay next to their caller.
- **No per-tenant cadence defaults list.** Cadence is the owner's declared
  policy, applied identically.

## Sequencing

M0 → M1 → M2 → M3 → M4 → M5 → M6. M3 and M4 change behaviour; M1 and M2 are
prerequisites for both (a run with no knowledge cannot produce a useful form, and
a prompt without facts produces generic forms). M5 is safe to start in parallel
after M3, but the bundle stage must not ship before M3 is green, or the cycle
will automate the old plan.

Expected shape of the result, stated so it can be checked: after one full cycle on
the disposable tenant, the board shows at least one opportunity whose business leg
cites a research source and whose search leg cites a measured query that came from
a finding's demand form, and the Business page shows research-proposed facts
awaiting acceptance.

## Definition of done

1. Every active site with a completed crawl has a usable knowledge document
   (M0 report), and a run started without one fails with a named reason.
2. One `SiteBrief` feeds synthesis, seeds, topic map and critique; the knowledge
   facts are visible in the prompt tests.
3. A research finding's demand forms can be bought by the monthly bundle and
   appear in the plan with their counts, without changing the cap.
4. Research-proposed knowledge is written as `advised` with a source, and never
   overwrites a confirmed fact.
5. Daily, weekly and monthly stages run from the worker, idempotently, and report
   blocked dependencies instead of skipping.
6. The opportunity page shows both legs populated for a research-led opportunity,
   and the demand page lists research candidates not yet measured.
7. `npm test`, `npm run lint` and `npx tsc --noEmit` pass; every milestone's
   verification command has been run and its output quoted in the PR.

## Implementation status — 2026-11-21

Implemented on `research-context-loop`. Two milestones landed narrower than
written above, on purpose; both deviations are recorded here so a later reader
does not mistake them for forgotten work.

- **M0** — `scripts/context-baseline.ts` (`npm run context:baseline`). Read-only.
- **M1** — extraction reads the latest crawl's stored text first and fetches only
  uncovered sections; `ensureBusinessKnowledge` gates the research runner, which
  now fails with `BUSINESS_KNOWLEDGE_MISSING` instead of completing thin. Source
  counts (`pagesFromCrawl`, `pagesFetched`, `pagesUnreadable`) are in the result.
- **M2** — `lib/site/brief.ts`; the synthesizer takes `brief` and renders the
  facts with their provenance status. **Deviation:** `proposeDiscoverySeeds`, the
  topic-map synthesis and `critiqueProposals` already receive business fields
  from `businessKnowledgeFields` at their own call sites, so they were left
  alone rather than rewritten for symmetry. Adopt the brief there only if one of
  them is found to be missing a field.
- **M3** — `ResearchFinding.demandQueries`, the synthesizer contract, the evidence
  bridge dimensions, `lib/research/demand-candidates.ts`,
  `planKeywordCandidates` in the bundle (20% cap reserve, deduplicated), and the
  join runner's query preference. `coverage` reports claimed, unclaimed, reserved
  and omitted counts.
- **M4** — `lib/research/knowledge-proposal.ts`, called after the findings bridge.
  Advised, source-attributed, never over a confirmed field, one revision per run.
- **M5** — `lib/jobs/site-cycle.ts` replaces `lib/jobs/monthly-cycle.ts`. Daily
  knowledge, weekly crawl + Search Console + sweep, research at the owner's
  cadence, monthly bundle behind `JobKind.BUNDLE` and dependent on the month's
  research. **Deviation:** the topic map is *not* scheduled. It requires an
  approval reference and proposes a taxonomy a person accepts
  (`docs/seo-intent-job-map-plan.md`); automating it would create a second,
  unapproved taxonomy path. Research candidates that need a new topic therefore
  wait, and the bundle reports them as unclaimed.
- **M6** — research evidence carries `sourceUrl` (shown as a link on the
  opportunity's Research stage) and the demand page lists forms research
  suggested but the cap has not bought. **Deviation:** the Business page already
  renders provenance kind and status per field, so grouping by kind was not
  added.
