# Business knowledge writer inventory

`Project` owns the canonical business knowledge document. Each accepted or partial intake write appends one full immutable snapshot in `BusinessKnowledgeRevision`; `BusinessKnowledgeDocument` is the compare-and-swap head and acceptance pointer. Retries are recorded in project-scoped `BusinessKnowledgeReceipt`. Acceptance is separately appended to `BusinessKnowledgeAcceptance` and does not create or mutate a content revision.

Each revision stores its reason, changed top-level field paths, service principal, and up to 100 IDs of pending project `ResearchAction` rows (`PROPOSED`, `DRAFTING`, `DRAFT_READY`) found during a correction; `affectedActionsHaveMore` signals truncation. `readBusinessKnowledgeCorrectionImpact` reads that durable record for downstream UI and research consumers. Corrections emit the existing connector outbox event per affected site with the bounded IDs and paths, asking consumers to recheck current work. A domainless project has no site event, so clients re-read the canonical revision and its impact ledger before work. No connector sequence is consumed when no event is written. This does not modify Actions, their history, review packages, approved content, or other projects. The current schema has no question/coverage entities or input-revision links, so this first slice limits impact to existing project Actions.

## Existing profile writers

| Writer | Fields | Compatibility behavior |
| --- | --- | --- |
| `saveResearchConfig` in `lib/research/policy.ts` | `SiteProfile.topics`, `audience`, `constraints`; research policy | Writes query topics, target segment, and market/goals/exclusions as research targeting policy. |
| `updateConnectorResearchPolicy` in `lib/connectors/service.ts` | same profile fields and research policy | Same independently editable research targeting and policy controls. |
| `updateConnectorResearchProfile` in `lib/connectors/service.ts` | profile snapshot plus research policy | Same independently editable research targeting and policy controls. |
| `saveContextSnapshot` in `lib/connectors/service.ts` | `ConnectorContextSnapshot.businessFacts` | Remains an observed crawl snapshot, not a source for owner-confirmed business facts. |

Compatibility mapping is intentionally explicit: `SiteProfile.topics` means research query topics; `SiteProfile.audience` means a target segment for research; `SiteProfile.constraints`/`ResearchPolicy` hold market, goals, exclusions and execution cadence. Canonical `BusinessKnowledge.fields.services` means owner sourced offerings, while `audienceMotivations` means sourced motivations. There is no automatic projection between those concepts. Existing SiteProfile rows are not automatically imported into the typed document; no ownership transfer or provenance is inferred. Business fact changes use the canonical document API.

## Acceptance authority

Project document writes require an existing project credential carrying `document:write`, bound to the exact workspace and project. Acceptance additionally requires a short lived HelloAda proof minted after the trusted owner check. The project organization must equal `helloada:<owner user id>`; the proof pins that organization, project, document and expected revision. The contract `actor` field must match the signed owner ID, and the signed actor is stored while the authenticated service principal is stored separately as `serviceCaller`. Caller JSON cannot claim owner authority. The project API returns `FORBIDDEN` for an unverified `workspace_admin` actor. No workspace admin mapping exists in CrawlSEO's project model; UI-008 can add the existing signed-in single-operator dashboard context as a verified admin actor through this acceptance service seam, without adding RBAC.

Historical reads select a concrete immutable revision. Accepted view additionally checks the append-only acceptance history and returns the selected historical accepted pin.
