# CrawlSEO pipeline implementation

## Steps
- [ ] UI-042: Define stage semantics and reusable pipeline navigation.
- [ ] UI-043: Implement a scoped, truthful action-lineage read model.
- [ ] UI-044: Establish one configuration owner and editor per setting.
- [ ] UI-045: Connect Research and Findings to their inputs and resulting work.
- [ ] UI-046: Consolidate drafts and agent execution inside the Work action.
- [ ] UI-047: Implement Results and a decision-oriented project overview.
- [ ] UI-048: Integrate navigation, compatibility routes and end-to-end acceptance.

## Approved product direction

Business -> Research -> Findings -> Work -> Results. This is a view of connected evidence and work, not a new job scheduler. Stages may overlap, retry or be absent; never pretend all work follows a completed linear sequence. AEO/GEO are dimensions of findings, work and results, not separate execution queues.

The overview answers: what do we know, what is running, what needs my decision, what improved? Settings is a utility outside the stages. Reuse the current theme, typefaces, panels and responsive layout. The signature visual element is the real stage sequence, not another grid of arbitrary metrics.

## Requirements

- PIPE-01: Stable stage names, destinations and terminology across desktop/mobile navigation and page headers. Show stage entry/exit, upstream inputs, downstream output links, and explicit blockers.
- PIPE-02: One canonical Work action. Drafts and agent tasks are children/attempts, not competing work items or queues. Preserve standalone task records without inventing a parent; label these exceptions and provide safe review links.
- PIPE-03: Recorded lineage: business revision -> research run/evidence -> finding -> action -> draft/task -> approval/delivery -> verification -> observed outcome. Missing links are explicitly not recorded. Never attach today's business revision or nearest-in-time research run as historical provenance. Site/project scope every read.
- PIPE-04: Each setting has one authoritative editor and the existing backing store. Business owns audience/services/markets/goals; Research owns targeting/source/recency policy; Project settings owns connections, schedule, spend limits and execution permissions. Separate canonical confirmed facts from legacy operational targeting, show precedence/divergence, and never silently overwrite or promote either.
- PIPE-05: Dedicated Findings surface aggregates actionable SEO/AEO/GEO/technical evidence with a dimension lens and links to existing actions. GET/render never launches research, drafts, paid calls or publishing. No duplicate action generation pathway.
- PIPE-06: Results distinguishes delivered, verified, observed change and causally demonstrated impact. Missing baseline, pending verification and no imported visibility are not successful outcomes or zero visibility.
- PIPE-07: Preserve existing API/tool contracts, published links, approval gates and automation. Old UI routes redirect or become detail lenses after integration; do not remove functionality until its replacement exists. Preserve relevant site/filter/action parameters. No schema migration in this phase.
- PIPE-08: All counts specify scope/time window; bounded lists disclose truncation, and cross-site exports/reads are denied. Unknown, stale, failed and empty states have a concrete upstream next step. Never render private tokens or raw provider errors.

## Task graph and ownership

First wave is independent: UI-042 (navigation primitives only), UI-043 (new lineage service only), UI-044 (configuration pages/forms only). Workers must not modify each other's files. UI-045 consumes all three; UI-046 consumes UI-042/UI-043; UI-047 consumes UI-042/UI-043. UI-048 consumes UI-044/UI-045/UI-046/UI-047 and owns the final sidebar switch and compatibility routes. Consumers start only after producer artifacts and tests are reviewed and merged.

### UI-042 — Stage contract and reusable navigation

Own `lib/pipeline/stages.ts`, `components/pipeline/**`, `tests/pipeline-stages.test.ts`, `docs/pipeline-stage-contract.md`.

Publish a pure typed stage contract: business `/business`, research `/research`, findings `/findings`, work `/work`, results `/results`; overview remains the site root, settings `/settings`. Export stable IDs, labels, owner/input/output descriptions and safe site-local URL builders. No query of live data or fake progress. Build an accessible pipeline nav component with aria-current and wrapping on mobile, plus an input/output/next-step strip for consumer pages. Tests cover stage resolution from nested routes, no cross-site URLs, escaping and keyboard semantics where feasible. Do not edit sidebar or existing pages yet. Contract docs identify legacy detail lenses (keyword-research, crawl, AEO/GEO, content studio) and future consumers.

### UI-043 — Recorded lineage model

Own `lib/pipeline/lineage.ts`, `lib/pipeline/lineage-types.ts`, `tests/pipeline-lineage.test.ts`, `docs/pipeline-lineage-contract.md`.

Inspect `getActionDetail`, `sourceIdsForAction`, current evidence JSON and Prisma relations. Provide a server-only read service for one site/action and a pure projection suitable for the UI. Resolve only actual IDs/revisions recorded by existing relationships, include timestamps/status and safe local detail URLs, and expose missing/unsupported links explicitly. Include business document/revision only if pinned in evidence, research run/finding/sources, drafts, agent attempts, delivery receipts and recorded verification/outcome. Do not equate a delivery receipt with live verification or impact. Findings/results consumers can use the contract but this task owns no pages, APIs or shared service changes. Mocked DB tests cover wrong site, missing action, legacy action, retries, missing revision, no receipts, delivered-unverified and verified-unmeasured. Document unresolved producer gaps rather than fabricating edges.

### UI-044 — Configuration ownership

Own business page/components, research config page/form, site settings page and new `lib/pipeline/configuration.ts` plus dedicated configuration tests. Existing APIs may be adjusted only through an explicitly reviewed scope expansion; first prefer their existing save contract.

Map every currently editable field to its store/editor. Reorganize the existing form(s) into exactly one editor per field: business facts/operational context, research policy, project operations. Existing endpoint payloads remain compatible. Business context edits must be labelled as operational context unless they use the canonical acceptance workflow. Do not claim confirmation from saving targeting. If moving a field requires a new API, document and stop for manager decision instead of retaining two editors. Remove Wix delivery diagnostics from Research and put them under Settings with bounded safe errors. Show effective value/source and read-only deep links elsewhere. No new profile store, credential, paid call or changed authorization. Tests exercise save/reload compatibility, unchanged hidden fields, absent profile, canonical-versus-operational divergence and unsupported providers. No sidebar change.

### UI-045 — Research to Findings

Depends on UI-042/UI-043/UI-044. Own research/keyword-research/aeo-geo pages and research components; new findings page/components/read service and dedicated tests. Keep keyword, SERP, market and prelaunch output families identifiable rather than combining incompatible metrics. Show the actual input snapshot when stored; label current configuration separately when no historical snapshot exists. Each run links to its findings and resulting actions. Findings has source/date/page, dimension filters, missing-evidence state and links to canonical Work; existing creation flows remain the only way to create work. AEO/GEO becomes a lens here with deep evidence tabs, no involuntary redirect to crawl/settings. Test nontrivial and empty journeys, wrong-site queries, failed runs and no side effect on GET.

### UI-046 — Work is the execution home

Depends on UI-042/UI-043. Own work/action detail pages, work components, content-studio page/components, `lib/work/service.ts` and dedicated tests. Reuse existing mutations and approval gates. Make action detail the canonical place for evidence, draft versions, agent execution attempts, review, delivery and verification. Work lists actions once; drafts and agent tasks link to parent action instead of competing tabs. Explicitly surface orphan standalone tasks with a safe review route and no invented action. Keep Content Studio as the editing lens inside selected work; preserve old links until UI-048. Tests cover multiple attempts/drafts under one action, legacy orphan records, approvals, external executors and no duplicate queue counts.

### UI-047 — Results and overview

Depends on UI-042/UI-043. Own site root/intelligence pages, new results page/components/read service and dedicated tests. Replace row-count tiles as the primary overview with actual next decisions, active runs/work, blockers and freshness, linking into each stage. Results links changed content to delivery receipts, verifier result, then measured search/AI observations with dates/baselines. Describe observed changes without causal attribution. Where measurement links or baseline are absent, say so; never create a new measurement backend here. Counts and time windows must be explicit. Test no observations, pending delivery, failed verification, verified-unmeasured, imported fixture exclusion and measured-without-attribution.

### UI-048 — Integrate and qualify

Depends on UI-044/UI-045/UI-046/UI-047. Own final sidebar/switcher integration, legacy route compatibility and browser/acceptance fixtures. Sidebar becomes Overview, five stages, Settings; supporting reports are contextual destinations, not top-level peers. Map old URLs explicitly and preserve filters/action identity. Follow one seeded journey from configured business through stored keyword evidence/finding/action/draft/receipt to honest Results, including missing-history, failed run and external-executor alternatives. Verify keyboard/mobile navigation and authorization. Full isolated install, Prisma generate, tests, typecheck, lint and production build. No production deploy until separately authorized. Keep issue open if the browser journey cannot be demonstrated; merged is not Verified.

## Execution and review

Use real child session IDs for claims. Coordinator serializes claim writes, not implementation. Isolated worktree per task on a current-default-branch baseline and pinned contract; no edits in the live `/SEO` checkout. Workers have no merge/deploy authority. First wave: Luna medium for UI-042/UI-044, Luna high for UI-043's bounded evidence mapping. Review actual diff and failing regression evidence before accepting handoffs. One targeted retry when warranted, then manager takeover or explicit replan. Do not permanently increase effort after a failure.

## Rollout and boundaries

Incremental additive pages/services first; switch navigation and retire duplicate editors/queues only after dependent replacements pass. No paid provider calls, customer publishing, credential changes or production migration are authorized by this plan. HelloAda remains a consumer of the same meaning; changes to its existing bridge/issue #19 require a separately pinned cross-repository task, not a duplicate pipeline implementation.
