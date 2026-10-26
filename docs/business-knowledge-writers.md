# Business knowledge writer inventory

`Project` owns the canonical business knowledge document. Each accepted or partial intake write appends one full immutable snapshot in `BusinessKnowledgeRevision`; `BusinessKnowledgeDocument` is the compare-and-swap head and acceptance pointer. Retries are recorded in project-scoped `BusinessKnowledgeReceipt`. Acceptance is separately appended to `BusinessKnowledgeAcceptance` and does not create or mutate a content revision.

Each revision stores its reason, changed top-level field paths, service principal, and the IDs of bounded pending project `ResearchAction` rows (`PROPOSED`, `DRAFTING`, `DRAFT_READY`) found during a correction. Corrections emit the existing connector outbox event per affected site with those IDs and paths, asking consumers to recheck current work. This does not modify Actions, their history, review packages, approved content, or other projects. The current schema has no question/coverage entities or input-revision links, so this first slice limits impact to the existing project Actions.

## Existing profile writers

| Writer | Fields | Compatibility behavior |
| --- | --- | --- |
| `saveResearchConfig` in `lib/research/policy.ts` | `SiteProfile.topics`, `audience`, `constraints`; research policy | Continues writing research policy and market/goals/exclusions. Once a canonical business document exists, it leaves `topics` and `audience` untouched. |
| `updateConnectorResearchPolicy` in `lib/connectors/service.ts` | same profile fields and research policy | Same fence for topics/audience; policy remains independently editable. |
| `updateConnectorResearchProfile` in `lib/connectors/service.ts` | profile snapshot plus research policy | Same fence for topics/audience; policy and language/constraints continue to update. |
| `saveContextSnapshot` in `lib/connectors/service.ts` | `ConnectorContextSnapshot.businessFacts` | Remains an observed crawl snapshot, not a source for owner-confirmed business facts. |

No remaining path in this inventory writes a canonical business fact into `SiteProfile` after the project document exists. Existing profile rows remain readable as compatibility data; they are not copied into the typed document without provenance.

## Acceptance authority

Project document writes require an existing project credential carrying `document:write`, bound to the exact workspace and project. Acceptance additionally requires a short lived HelloAda proof minted after the trusted owner check. The project organization must equal `helloada:<owner user id>`; the proof pins that organization, project, document and expected revision. The contract `actor` field must match the signed owner ID, and the signed actor is stored while the authenticated service principal is stored separately as `serviceCaller`. Caller JSON cannot claim owner authority. Admin acceptance through the signed-in operator is left to UI-008, which owns the correct dashboard workflow.

Historical reads select a concrete immutable revision. Accepted view additionally checks the append-only acceptance history and returns the selected historical accepted pin.
