# Code inventory and baseline

Review date: 2026-10-25. Exact fetched source revisions:

| Repository | Revision | Role |
| --- | --- | --- |
| crawlseo | `86325bb4dc75b46ad657388e7f6d30690d58d226` | Intelligence, crawl, analytics, Actions and existing delivery |
| site-agent | `8ffdcddb3e7a35b9d27452abdf23f8c871a09e64` | Intake, incubation, context, design, tenant runtime and HelloAda execution |
| helloada | `5e4dc98b355704f3162738220e77a5c2cb40e9fa` | Project selector, bootstrap and owner handoff |
| wix-site-bridge | `2eae493ca952f6b503e4ccd2f767ac9abdeb7e16` | Generic manifest-scoped Wix tooling |

This is a source architecture review, not proof of deployment, tenant activation
or exhaustive line-by-line review of all files. Entry points, contracts,
persistence, producers, consumers and relevant test suites were traced.
Recheck current main and active PRs before claiming implementation issues.

## Source map

All paths are repository-relative. Site-Agent application paths below have prefix
`src/site_agent/`; its `docs/`, `tests/`, `packages/` and `contracts/` do not.

| Area | Code and contracts | Reuse / remaining work |
| --- | --- | --- |
| HelloAda creation | `src/app/api/helloada/websites/route.ts`, `src/lib/website.ts` | Reuse idempotent tenant/bootstrap identity; extend existing registration path for early intelligence identity if needed |
| Owner journey | Site-Agent `docs/helloada-project-selector-to-payload-intake-contract.md` | Canonical Payload workspace; do not revive separate Intake Lab UI |
| Intake | `core/design_intake_contracts.py`, `application/design_intake.py`, `application/intake_coordinator.py` | Typed fields/provenance and confirmation already exist; growth completeness and remote knowledge handoff need work |
| Incubation research | `brain/incubation_research.py`, `application/incubation_research.py`, `hands/feed_discovery.py` | Reuse bounded planning, source trust and findings; independent local executor remains a consolidation target |
| Accepted context | `application/customer_context.py`, `application/customer_genesis.py`, `core/customer_context_contracts.py` | Preserve accepted immutable snapshots and task-shaped views; add canonical external business/research composition |
| Research authority | `config.py`, `core/research_authority.py`, `core/jobs.py`, `application/growth_workflow.py` | Existing freeze/activation fences and local producer suppression; audit incubation callers as well |
| SEO provisioning | `application/seo_provisioning.py`, `hands/crawlseo_provisioning.py` | Domain/Google provisioning exists; not an early domainless knowledge-registration contract |
| Connector client | `application/crawlseo.py`, `hands/crawlseo.py`, `senses/crawlseo.py` | Application-service/client boundary exists; extend negotiated capabilities |
| HelloAda execution | `application/growth_workflow.py`, `growth_candidates.py`, `growth_delivery.py`, `growth_owner_response.py` | Remote Actions project into existing owner work; exact candidate/review/receipt path exists |
| Shared owner runtime | `packages/helloada-payload-core`, shared Payload admin and `templates/next-payload` | Expose shared knowledge/policy records; keep existing CMS schema/owner authentication boundaries |
| Tenant release | `docs/crawlseo-migration-operations.md`, `deploy/README.md`, release scripts/manifests | Preserve official exact-SHA API/package/Worker release and migration gates |
| CrawlSEO project | `lib/projects/provision-project.ts`, `lib/projects/project-site.ts` | Reuses external organization/project IDs; current provisioning requires site and Google inputs |
| Persistence | `prisma/schema.prisma` | Project/SiteProfile/context/Research*/Actions/jobs/budget/receipts exist; research and job entry points still require Site |
| Research configuration | `lib/research/policy.ts`, `lib/connectors/types.ts`, `lib/connectors/service.ts` | Atomic research-profile API already implemented; narrower topics/audience/market projection, not full business intelligence |
| Market research | `lib/research/runner.ts`, `synthesizer.ts`, `providers/*`, `quality.ts`, `evidence.ts` | Reddit/news RSS, query plan, quality and sourced Actions; no general-web/competitor provider implementation |
| Research synthesis inputs | `lib/research/runner.ts` around `synthesizeResearch` | Receives brief/audience/questions/sources and up to 30 crawl URLs; full connector businessFacts and actual page bodies are absent |
| Source storage / dedupe | `lib/research/service.ts` | Existing ingestion and Action dedupe; sources are run-scoped and need durable reuse/observation identities |
| Search evidence | `lib/dataforseo/*`, `lib/google/*`, `lib/workers/*`, `lib/reports/monthly-site-evidence.ts` | Specialized keyword/SERP/GSC/GA4 evidence stays under shared authority; do not reimplement providers in Ada |
| Crawl / schema | `lib/crawler/engine.ts`, `technical-actions.ts`, `lib/research/crawl-live-check.ts` | Schema presence check and crawl evidence exist; parse/semantic/content consistency and bounded execution capabilities need extension |
| Opportunity generation | `lib/seo-opportunities.ts`, `lib/ai-seo/content-plan.ts`, `lib/research/seo-actions.ts`, `keyword-actions.ts`, `crawl-actions.ts`, `lib/editorial/*` | Reuse signals/editorial decisions and Action identity; add question/coverage inputs and input revision discipline |
| Connector authority | `lib/connectors/*`, `docs/site-agent-connector-contract.md` | Scoped v1 API, generation, events, exact approval hashes/attempts; helloada and crawlseo-agent supported, Wix/Webflow gated |
| Work / configuration UI | `lib/work/service.ts`, `app/(dashboard)/sites/[siteId]/work`, `research/config`, `components/research/*` | Views already exist; unify configuration writers and add project-level intelligence admin |
| CrawlSEO Wix delivery | `lib/bridge/client.ts`, `lib/delivery/wix-embed.ts`, `wix-blog.ts`, `wix-publish.ts` | Existing local specialized machinery; not proof of a validated generic Wix connector |
| Bridge manifest / API | Wix `src/manifest.mjs`, `security.mjs`, `wix-client.mjs`, `mcp.mjs`, `bridge.mjs` | Target allowlists, explicit alias, dry-run and API scopes exist; advertise only real operations |
| Bridge release | Wix `src/release.mjs`, `release-operation.mjs`, `publish.mjs` | Snippet CAS/readback, private snapshots, partial receipts; non-atomic code + snippets, no automatic code rollback |

## Material integration gaps

1. Business context can be exported without reaching market synthesis.
2. Incubation research still constructs a local collection/execution service.
3. Domainless intelligence is not covered by the current Google/site provisioning.
4. Intake accepts useful growth fields without requiring them for build readiness.
   This is not inherently a bug; add progressive readiness rather than a huge form.
5. Existing accepted context and editable SiteProfile/policy need explicit ownership
   and revision semantics before making business knowledge centrally editable.
6. Page candidate URLs do not demonstrate question coverage.
7. CrawlSEO's bridge client names operations/flags and local site layouts that
   exceed the fetched generic bridge main surface. The host bridge checkout also
   contains customer-specific instructions and capabilities absent from remote main.
   Inventory exact operations/receipts and promote reviewed generic tooling before
   relying on that host behavior. Do not copy private customer artifacts into GitHub.
8. Wix source publication implementation includes CLI/internal-revision behavior
   that must be reconciled with documented bridge APIs and target-specific human-
   only publication policies. Do not interpret existing code as blanket authority.
9. No reviewed Webflow adapter was found in these repositories. It remains planned.
10. Existing [Site-Agent #252](https://github.com/weareheadless/site-agent/issues/252)
    tracks incomplete exact source-maintenance rendering/review. Its presence is
    a capability-specific blocker, not evidence that all HelloAda candidate paths
    work or a requirement to redesign that pipeline in this initiative. The first
    content slice must prove its own existing Payload review path separately.

## Existing test anchors

CrawlSEO: `tests/connector-research-profile.test.ts`, `connector-context.test.ts`,
`connector-actions.test.ts`, `connector-preparation-evidence.test.ts`,
`research-action-dedupe.test.ts`, `research-synthesizer.test.ts`,
`research-query-plan.test.ts`, `research-quality.test.ts`, `connector-budget.test.ts`,
`technical-actions.test.ts`, `wix-blog-approval.test.ts`, `wix-publish.test.ts`.

Site-Agent: `tests/test_incubation_research.py`,
`test_incubation_research_planner.py`, `test_customer_context_handoff.py`,
`test_crawlseo.py`, `test_crawlseo_accounting.py`, `test_crawlseo_cutover.py`,
`test_crawlseo_activation.py`, `test_crawlseo_migration_control.py`,
`test_crawlseo_technical_evidence.py`, `test_research_authority_freeze.py`.

Wix Bridge: `test/manifest.test.mjs`, `security.test.mjs`, `mcp.test.mjs`,
`release.test.mjs`, `publish.test.mjs`, `wix-client.test.mjs`.

These suites were located/inspected as architecture anchors, not reported as
executed in this documentation-only work. Implementation issues require focused
behavioral tests and the applicable repository checks.
