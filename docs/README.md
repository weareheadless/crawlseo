# CrawlSEO documentation

Keep this set small. If a document is not listed here, it is historical and lives
in [`archive/`](archive/README.md). Do not use archived documents as current
requirements.

## Read first

- **[CrawlSEO product operating model](crawlseo-product-operating-model.md)** —
  authoritative product requirements, cadence, proposal model and definition of
  done.
- **[CrawlSEO simplified execution plan](crawlseo-simplified-execution-plan.md)** —
  how to build it: data layers, AI calls, phases and pilot acceptance.
- **[Intent and job map workstream](seo-intent-job-map-plan.md)** — the active fix
  to demand qualification: one job-map pass, the taxonomy projected from it,
  per-query demand verdicts in tranches, and the guardrails that keep it from
  drifting back into word matching.
- **[Competitor visibility and opportunity quality](competitive-visibility-plan.md)**
  — the active plan for making the board say who holds the positions we want, why
  they hold them, and what moved after the work shipped. Measured current state,
  spend, and the CMP-001…009 issues.
- **[What each issue delivers](competitor-visibility-results.md)** — the same plan
  in plain SEO terms: what breaks today, what each CMP issue makes true, and how
  you would know it worked.

## Active operating docs

- [Wix delivery loop](wix-delivery-loop.md) — the lanes, page states and human
  steps.
- [Wix page delivery contract](wix-page-delivery-contract.md) — the early
  packet + mount mechanics, locales and reachability. Read this before touching
  Wix delivery code or docs.
- [Agent coordination](agent-coordination.md)
- [Agent workflow](architecture/centralized-intelligence/agent-workflow.md)
- [Business knowledge writers](business-knowledge-writers.md)

## Reviews

- [Analyst review — 2026-11](analyst-review-2026-11.md)
- [SEO review — 2026-11 one-pass run](seo-review-2026-11-one-pass.md)

## Active contracts

- [Atelier monthly bundle pilot](pilot-atelier-bundle.md)
- [Pipeline stage contract](pipeline-stage-contract.md)
- [Pipeline lineage contract](pipeline-lineage-contract.md)
- [Pipeline configuration contract](pipeline-configuration-contract.md)
- [AEO question set contract](aeo-question-set-contract.md)
- [AEO observation contract](aeo-observation-contract.md)
- [AEO Google AI Overviews contract](aeo-google-contract.md)
- [AEO Perplexity contract](aeo-perplexity-contract.md)
- [AEO run contract](aeo-run-contract.md)
- [External execution over MCP](external-execution-mcp.md) — how an outside agent
  finds work, does it in a site's own repository, and reports back without pretending a
  person confirmed it.
- [Site-agent connector contract](site-agent-connector-contract.md)
- [Runtime connector credential issuance](runtime-connector-credential-issuance.md)
- [Legacy budget import](legacy-budget-import.md)

## Code-referenced architecture notes

These are referenced by code comments, migrations or tests. They are reference
material, not product requirements.

- [Opportunity capability ownership](architecture/opportunity-capability-ownership.md)
  — which producer owns each of the 14 opportunity types, who may change a row's
  state, and how a capability that cannot run reports itself. Read this before
  adding a producer, a detector or a retirement path.
- [SEO funnel spine plan](seo-funnel-spine-plan.md)
- [Demand map cluster discovery](demand-map-cluster-discovery.md)
- [DS-02 run unification](ds-02-run-unification.md)
- [Wave 6 cleanup ledger](wave6-cleanup-ledger.md)

## Historical

- [Archive index](archive/README.md)
