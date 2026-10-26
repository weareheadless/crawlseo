# ADR 0001: Shared intelligence with platform-owned execution

Status: proposed. Date: 2026-10-25. Requirements: ID-001, KNOW-001–006,
RES-001, EXEC-001–007, MIG-001–004.

## Context

Intake and incubation already retain rich facts and sourced research. CrawlSEO
already owns research/Action infrastructure and can receive business snapshots,
but its synthesis consumes a narrower brief. Independent collections, policy
forms and local context snapshots can drift. A site-first lifecycle excludes
early business research. AI visibility needs question/claim/content/evidence
relationships from the start, rather than a later isolated scoring tool.

## Decision

Propose CrawlSEO as the eventual authority for versioned business knowledge,
research, shared question/coverage records and AI/search observations. Keep
Site-Agent's conversations, assets, creative context and design pipeline local.
Keep content with its CMS and approval/execution with the assigned executor.
Use existing connector state, events, budgets and candidate receipts.

Transfer knowledge ownership explicitly after import/read comparison; until then,
existing origin records remain authoritative. A synchronized snapshot alone is
not an authority transfer. An admin may change facts through the canonical
service without impersonating an owner or bypassing publication approval.

## Consequences and alternatives

Benefits: one correctable intelligence model from intake through AI observations
and execution, source reuse, inspectable decisions and fewer duplicate writers.
Costs: prelaunch project APIs, provenance migration, consumer compatibility and
stronger dependencies on the intelligence service. Existing website serving
does not depend on a live CrawlSEO request; new intelligence effects may wait
honestly during an outage using pinned accepted inputs where allowed.

Rejected: duplicating profiles per UI; centralizing CMS/auth/conversations;
rewriting all jobs into a new framework; one universal autonomous publisher;
schema-only AI optimization; adopting a monorepo just for issue tracking.

## Change control

Acceptance of this ADR is a design decision, not a customer cutover. A later
ownership change needs a new ADR, migration evidence, compatible consumers and
explicit treatment of outstanding work, approvals and spending.
