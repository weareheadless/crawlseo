# Unified intake, research, website and growth journey

Historical discovery review. The maintained architecture proposal and agent
implementation backlog now live in
[centralized-intelligence](architecture/centralized-intelligence/README.md).
Use that reference for current requirements, baseline and ownership decisions.

Code review dated 2026-10-25. This is a proposed product/architecture direction,
not an implementation or a production acceptance report.

## Scope and evidence

Inspected CrawlSEO `/SEO` at `86325bb`, Site-Agent
`/home/admin/site-agent-implementation` at `ee68d38`, and HelloAda selector
`/SOCIAL/helloada-intake-handoff-20261021` at `5e4dc98`.
These are local checkouts; deployment versions and individual tenant activation
were not verified. Older sibling checkouts exist and must not be treated as the
current production implementation.

Relevant sources:

- HelloAda `src/app/api/helloada/websites/route.ts`: idempotent website identity,
  tenant registration, durable bootstrap status.
- Site-Agent `docs/helloada-project-selector-to-payload-intake-contract.md`:
  selector -> tenant bootstrap -> authenticated Payload handoff -> intake ->
  candidate -> owner approval -> release. Older Intake Lab UI topology is superseded.
- Site-Agent `core/design_intake_contracts.py`: allowed business/audience/brand
  fields, provenance, unresolved core paths, confirmed intake.
- Site-Agent `application/intake_coordinator.py` and
  `application/incubation_research.py`: intake-triggered research planning,
  independent feed discovery/reading, local sources/findings/jobs/insights.
- Site-Agent `application/customer_context.py`: immutable context derived from
  an accepted design run, intake, genesis, research and approved knowledge;
  bounded views for strategy, editorial, research and design.
- Site-Agent `application/growth_workflow.py::_sync_crawlseo_actions`: sends
  inventory/document hashes and the strategy context as `businessFacts`, projects
  remote Actions into existing owner work, reuses candidate/approval execution.
- Site-Agent `docs/crawlseo-connector.md`: explicit research authority, suppression
  of legacy Growth producers, executor boundary and current connector limits.
- CrawlSEO `lib/projects/provision-project.ts`: project/site/integrations,
  credentials, executor binding and GSC/GA4 sync; no intake payload.
- CrawlSEO `prisma/schema.prisma`: SiteProfile, connector context, ResearchRun,
  ResearchSource, ResearchFinding, ResearchAction, execution and outcome records.
- CrawlSEO `lib/connectors/types.ts` and `lib/connectors/service.ts`: context and
  research-profile APIs, revisions, scoped operations and execution lifecycle.
- CrawlSEO `lib/research/runner.ts` and `synthesizer.ts`: bounded RSS research,
  source quality checks and evidence-linked content Actions.
- CrawlSEO `lib/research/service.ts`: finding/source ingestion and Action dedupe.
- CrawlSEO `lib/ai-seo/content-plan.ts`: GSC opportunities joined with crawl data.
- CrawlSEO `lib/work/service.ts`: existing consolidated work/detail read models.

Site-Agent source paths above are relative to `src/site_agent/` unless starting
with `docs/`.

## Current journey and where continuity breaks

1. The owner creates a project through HelloAda. Site-Agent prepares the tenant
   workspace; the owner enters its Payload admin.
2. Ada collects the brief. Existing fields already include services, location,
   service area, differentiators, verified trust evidence, audience motivations
   and concerns, conversion goals, voice and prohibited claims. Provenance
   distinguishes confirmed/advised/assumed/deferred values.
3. Intake revisions can trigger local incubation research. Its service discovers
   and reads feeds and stores sources, findings and insights in Site-Agent memory.
   The intake advisor reads a bounded knowledge briefing.
4. Confirmed intake feeds Ada's design pipeline. Context snapshots retain intake,
   research and knowledge lineage at accepted-run/provisioning boundaries.
5. SEO provisioning connects domain, GSC, GA4 and CrawlSEO. CrawlSEO's provisioning
   input requires domain/Google setup; it is not an early incubation-registration
   interface. Provisioning queues GSC/GA4 sync, not the entire audit journey.
6. Under explicitly configured CrawlSEO authority, Growth sync sends inventory
   and business context and receives Actions. HelloAda prepares and publishes
   through its existing review flow and reports execution receipts.
7. CrawlSEO's market synthesis receives topics, goals, audience, market,
   questions, public sources and up to 30 crawl-derived candidate URLs. It does
   not receive the full connector business context or substantive page bodies.

Consequences:

- Rich business knowledge can arrive in a context snapshot without actually
  informing the research synthesizer.
- Incubation feed research remains a separate producer; the inspected coordinator
  constructs it directly, rather than routing through the CrawlSEO authority gate.
  Existing authority controls for Growth do not prove incubation is unified.
- SiteProfile/research configuration and connector businessFacts overlap with
  intake/context, without one typed field-ownership contract across them.
- Research is attached to site/run records. A business without a public website
  has no clean first-class research journey in the current provisioning path.
- Candidate URLs alone are insufficient evidence that a page answers a pain point.
- Source uniqueness is run-local; historical reuse needs explicit durable identity
  and freshness rules, not another copy of the same research on every run.
- Differentiators, concerns and trust evidence are allowed intake fields but are
  not all required core fields. Build readiness does not establish growth readiness.
- The RSS runner implements Reddit and news; general web and competitor providers
  are explicitly unsupported. Reddit RSS search is not a full comment-analysis system.

## Recommended ownership

CrawlSEO should be the shared business-and-market intelligence service used from
incubation onward. Keep the owner experience inside the existing tenant workspace.

| Information or operation | Authoritative owner | Other systems |
| --- | --- | --- |
| Structured business facts and their revision history | CrawlSEO, after explicit migration | Intake supplies owner statements/corrections; Ada consumes bounded views |
| Conversation, creative identity, assets and design decisions | Site-Agent | Share only necessary business/brand projections |
| Research requests, source observations, findings, questions | CrawlSEO | Ada requests research and reads its results |
| Website content and document revisions | Payload or Wix | CrawlSEO stores linked observations and inventory |
| Crawl/GSC/GA4 evidence and AI visibility observations | CrawlSEO | Owner workspace displays projections |
| Prioritized growth Actions and research budget | CrawlSEO | Executors consume exact Action revisions |
| Candidate generation, owner review, approval and publication | Assigned executor | CrawlSEO receives exact execution and verification receipts |

Centralization means one authority per record, not putting every customer record
in one database. Do not migrate private conversations or the CMS into CrawlSEO.
Until a reviewed knowledge migration is complete, Site-Agent remains the origin
of its existing accepted context; imported snapshots must retain that identity.
Do not establish two independently editable business profiles during transition.

## Proposed unified owner journey

1. Create one project identity before a domain or analytics exists. Register it
   with CrawlSEO without requiring a public Site, GSC or GA4.
2. Ada asks a short first intake using the existing contract. Persist structured
   facts with source message/reference, revision, status and intended public use.
3. As enough context becomes available, Ada requests bounded incubation research
   from CrawlSEO. Results come back as sources, findings and unanswered questions.
4. Ada asks only consequential follow-ups. Separate owner-declared facts from
   independently supported evidence and public-market hypotheses.
5. The owner confirms a versioned business brief. Ada's design and content stages
   consume the same revision and linked research, through existing task views.
6. Validate the private candidate: editable content, business-fact consistency,
   question coverage, applicable schema and links. Do not index private previews.
7. On approved launch, attach the canonical domain and available analytics to the
   same project; trigger a public baseline crawl after publication is verified.
8. Ongoing research, search performance, crawl and AI observations feed one Action
   backlog. Prefer extending an appropriate existing page to creating redundant pages.
9. The assigned executor prepares an exact candidate for review, publishes under
   existing approval rules, and reports receipts. CrawlSEO verifies and measures.
10. New owner corrections or material research changes reassess affected pages and
    pending Actions; preserve older evidence and decisions rather than overwriting them.

Existing-site customers enter at import/confirmation of observed facts, then join
the same research/audit/Action journey. Observed website copy is not automatically
owner-confirmed truth.

## Missing functionality to build

- Project-level knowledge before launch, with typed business entities and
  field-level provenance. Extend the existing profile/context boundary rather
  than adding a third general-purpose context store.
- Business-to-site relationships: offerings, actual locations versus service
  areas, audience segments, languages and evidence-backed differentiators.
- Progressive completeness: essential launch facts, missing growth inputs, and
  optional enrichment. Unknown or not-applicable are valid explicit states;
  do not make every question a mandatory onboarding field.
- Linked research questions/pain points: question -> segment/service/location ->
  sources/findings -> existing content section -> Action -> publication -> outcome.
  Preserve contradictory observations and avoid calling one Reddit post a trend.
- Research requests from intake, including verified communities, approved feeds,
  language, exclusions and purpose. Reuse the source controls already implemented
  in incubation instead of replacing them with a less capable global topic search.
- Stable source observation identities, freshness-aware reuse and repeat-request
  dedupe. An unchanged source need not be bought or fetched again unnecessarily;
  a changed page gets a new observation without losing its history.
- Content coverage assessment using actual approved content/document revisions
  and headings/sections. A URL list cannot establish a content gap.
- Change propagation: fact corrections and new research invalidate relevant
  projections and trigger scoped reassessment, not an automatic site-wide rewrite.
- AI visibility observations linked to the same question inventory and Actions;
  distinguish sampled mentions, citations, referrals and conversions.
- One owner-facing status per work item, including missing information and blocked
  execution. Show why a recommendation exists and which verified facts support it.

## Reuse and consolidation

- Reuse DesignIntakeDraft, its provenance and confirmation semantics. Keep Ada's
  conversational orchestration; replace independent research dispatch with a
  CrawlSEO application-service adapter after equivalent capabilities exist.
- Reuse CustomerContextService.task_view as the consumer boundary. Make it compose
  authoritative business/research revisions with local creative context; do not
  replace it with a second prompt-builder hierarchy.
- Extend existing connector context/research-profile services. Business facts,
  research policy and website observations have different ownership and freshness;
  do not treat all three as a single undifferentiated JSON blob.
- Reuse ResearchRun/Source/Finding ingestion, Action dedupe, event delivery,
  generation fencing and executor receipts. Imported incubation evidence needs
  source IDs and revision mappings, not matching by text/title/date.
- Keep market, keyword and SERP research as specialized jobs under one authority;
  consolidate evidence/identity/budget contracts rather than forcing every job
  into the same provider or prompt.
- Keep HelloAda's existing candidate/approval/owner task projection and Wix's
  executor-specific preparation. No second owner approval queue.
- Research, Opportunities, Content Studio and Work should expose views of shared
  records. Check existing producers before adding a new AI-specific task pipeline.

## Inspectable intelligence and configuration

Additional product direction: expose the shared intelligence as readable,
editable configuration in CrawlSEO, giving HelloAda administrators tools to
understand and tune Ada's decisions. HelloAda's tenant workspace may expose
appropriate views of the same records through the connector. Neither interface
maintains its own independently editable copy.

| Admin view | Inspect | Change |
| --- | --- | --- |
| Business profile | Services, audiences, locations/service areas, differentiators, trust evidence, provenance and unknowns | Correct facts, attach evidence, mark applicability and publication permission |
| Research strategy | Questions, communities, feeds, competitors, exclusions, language, cadence, freshness and budget | Prioritize questions, approve/exclude sources, adjust bounded research settings |
| Content coverage | Which questions have answers, the supporting business facts, exact pages/sections and gaps | Correct mappings, choose the relevant page, request missing information |
| Decision evidence | Action rationale, source observations, context revisions, priority basis, alternatives and blockers | Dismiss with a reason, correct an assumption, request reassessment |
| Execution policy | Assigned executor, supported operations, preparation settings and pending review state | Tune permitted preparation through existing policy; preserve exact publication approval |
| Outcomes | Verified changes, citations/mentions, referrals and conversions with observation scope | Configure relevant questions/goals and measurement windows |

Treat factual records, inferred findings and research controls as distinct kinds
of information. Configuration is not permission to rewrite source evidence or
silently turn an inference into an owner statement. Admin-origin corrections
retain the actor and basis, and must not be labelled owner-confirmed unless the
owner actually confirmed them.

Every meaningful edit should show its source/current revision, proposed diff,
validation and affected questions/pages/Actions. Save an immutable revision and
audit event, then refresh HelloAda's derived context. Reassess affected pending
work when its inputs change; leave published content unchanged until the normal
candidate and approval flow completes. Never silently replace an approved
candidate with a newly generated package.

Use existing project/tenant authorization for business controls and separate
operator access for platform policy, credentials and executor transfer. Owners
must not be asked to understand prompts or model settings to correct business
facts. Provide concise explanations and evidence summaries, not private model
reasoning. Prompt/model versions and technical diagnostics belong in operator
detail where useful.

Acceptance: an authorized admin corrects a service area once in CrawlSEO, sees
the recorded diff and affected work, and HelloAda uses the new revision without
another intake or a duplicate profile. A stale concurrent edit conflicts, an
unauthorized tenant cannot read/change the record, and an existing approval
cannot authorize different content after the correction.

## Delivery order and acceptance

1. Agree field ownership and a versioned business-context contract; prove existing
   accepted intake can be read through it without re-asking or losing provenance.
2. Support prelaunch project research and import existing incubation evidence with
   stable origin mappings. Preserve current source permissions and history.
3. Route incubation research through CrawlSEO; prove one owner turn creates one
   bounded job, results return to intake, and retries create no duplicate spend/work.
4. Make research synthesis and candidate planning consume that same context and
   content inventory. Prove a known pain point maps to the correct existing page.
5. Connect launch verification to the initial public audit and one Action backlog.
   Prove no second site/project or duplicate owner task is created.
6. Add schema consistency, deeper content coverage and AI monitoring as evidence
   producers on this foundation.

End-to-end acceptance: intake -> sourced pain point -> confirmed business answer
-> initial content -> approved publication -> baseline crawl -> one improvement
Action -> executor review/publication -> verification/outcome, all traceable to
one project and explicit knowledge/content revisions. Test both a prelaunch
business and an imported existing site, plus an owner correction and a retry.

No application code, tenant configuration or production state was changed by this
review. Runtime tests were not run because this deliverable is a code analysis.
