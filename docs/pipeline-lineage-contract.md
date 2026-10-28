# Recorded action lineage contract

`readActionLineage(siteId, actionId)` is a server-side, read-only service returning `ActionLineage`; it looks up the action with both identifiers, throws the existing `ResearchServiceError` (404) for absent or other-site actions, and performs no provider calls or writes. `projectActionLineage(action, sourceRows?)` is the pure consumer projection. Public types are exported from `lib/pipeline/lineage-types.ts`.

The result contains safe display nodes, directed recorded edges, explicit link state (`recorded`, `not_recorded`, `unsupported`) and disclosed list limits. Node detail URLs are local paths; external source URLs are included only when HTTP(S). Agent error fields, prompts, results and credentials are not projected. The DB selects only needed fields. The sources query is constrained to IDs explicitly cited by the action/finding and the action's recorded site-local research run; source rows are checked again before projection.

## What the records mean

- Research run and finding are included only through the action's direct foreign keys and matching run identity. Sources are exact IDs selected by `sourceIdsForAction`, never selected by query, URL similarity or recency.
- Business lineage is shown only for an explicit `business_document_id`/`businessDocumentId` together with `business_revision`/`businessRevision` in action evidence. Current accepted revisions are never substituted. This repository has no standardized producer field or enforced document/revision relation on actions, so absent evidence is `not_recorded`; values are reported as pinned evidence, not independently verified against current business records.
- Drafts and agent attempts are children only when their existing action relation points to the action. Their lists cap at 100; delivery receipts cap at 20; sources cap at 200. Consumers must treat lists as potentially truncated (limits are returned, not total counts).
- A delivery receipt means delivery record only. Recorded action/delivery verification timestamps produce a verification node. A measured outcome requires both `outcome` and `outcomeMeasuredAt` on a receipt. None of these states proves causal impact.

## Known producer gaps

Actions do not consistently pin a business revision; no historical revision edge is inferred. Existing `QuestionCoverage` relations can refer to business revision/document but are not treated as action provenance because they are not a guaranteed pinned input. Receipt outcomes are not consistently populated and do not necessarily contain a measured search observation or baseline. Unsupported producer states are reserved in the shared union for consumer-forward compatibility; this implementation reports missing records as `not_recorded` rather than inventing unsupported relationships. No schema, API, page or write behavior changes are part of this contract.
