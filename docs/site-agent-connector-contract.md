# Site-Agent connector contract

CrawlSEO is the shared research authority for a project. Site-Agent remains
the only owner-facing approval and website executor when a site's binding is
`helloada`. The connector never publishes content.

## Authentication and scope

Provision one service credential for the project with `connector:read` and
`connector:write`. Send it as `Authorization: Bearer <token>` to
`/api/connector/v1/*`. Credentials are project-scoped, stored as hashes, and
must not be exposed in browser code or logs. The provisioned connector binding
is returned alongside `credentialScopes`, the exact scopes of the authenticated
credential. Backend `capabilities` describe available operations; they do not
prove that a read-only migration credential may execute writes. Authority-mode
preflight must require both `connector:read` and `connector:write` in
`credentialScopes` before selecting a runtime credential. The binding itself
contains the active executor and a monotonically increasing generation; every
write carries that generation so a transferred or stale executor is rejected.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/capabilities?siteId=…` | Read schema version, the selected site's active binding and supported operations. |
| GET | `/opportunities?siteId=…&limit=…&cursor=…` | Read canonical project Opportunities and their Tasks; cursor-paginated, at most 100 Opportunities. |
| POST | `/opportunities/{opportunityId}/operations` | Relay an explicit human accept, park or reject decision against the reviewed version. Acceptance creates the canonical Task. |
| GET | `/tasks/{taskId}?siteId=…` | Read a project-owned Task and its Opportunity. |
| POST | `/tasks/{taskId}` | Relay an explicit human task-status confirmation. |
| GET | `/analytics?siteId=…&startDate=…&endDate=…` | Read saved GA4/GSC observations, connection/sync health, coverage and any row truncation. Does not call Google or queue work. |
| GET, PUT | `/context?siteId=…` | Read or compare-and-swap the current site inventory, business facts, origin and capabilities. |
| GET | `/findings?siteId=…&runId=…` | Read project/site-scoped findings with source lineage and linked Action revisions, using a bounded cursor. |
| GET | `/actions?siteId=…` | List current site Actions, bounded to 100 per request. |
| GET | `/actions/{actionId}?siteId=…` | Read one current Action envelope and its linked evidence/execution state. |
| POST | `/actions/{actionId}/operations` | Accept/decline preparation, request correction, or cancel preparation with expected revision, generation and idempotency key. |
| POST | `/actions/{actionId}/execution` | Record preparation, owner-decision, publication and outcome states. |
| GET, POST | `/events?siteId=…` | Poll the selected site's at-least-once event outbox, acknowledge durable local receipts, or schedule retry with backoff. |
| GET, PUT | `/policy?siteId=…` | Read or compare-and-swap the market research policy and business profile (`SiteProfile` + `ResearchPolicy`). |
| PUT | `/research-profile` | Atomically write the business profile, research policy and paid SEO research policy (`SiteProfile` + `ResearchPolicy` + `SeoResearchPolicy`) with revision and idempotency guards. Does not change research authority or spend money. |
| GET, PUT | `/budget` | Read the project allowance or compare-and-swap its monetary cap, currency and IANA timezone. |
| POST | `/budget/reservations` | Reserve a bounded amount before billable provider dispatch. |
| POST | `/budget/reservations/{reservationId}` | Settle actual cost, release a proven pre-dispatch reservation, or hold an uncertain outcome. |
| POST | `/api/internal/sites/{siteId}/connector-transfer` | Operator-only, idempotent executor transfer after event, spending and owner-decision reconciliation; increments the binding generation. |
| POST | `/api/internal/sites/{siteId}/connector-credentials` | Provisioning-token-only, additive `connector:read` credential for migration inventory and read-only comparison. |

The migration credential operation is deliberately separate from project
provisioning: it requires an already-existing project site, creates a distinct
`helloada-migration-read` principal, grants only `connector:read`, and never
revokes the site's legacy MCP credential or enqueues provider work. The
credential expires after 30 days. Its body
contains only an idempotency key; the generated token is returned once. A
retry with the same key returns the credential identity without reprinting
the token. The token is project-scoped and must remain in the private
HelloAda control plane. It does not activate an executor, enable research,
transfer budget authority, or permit acknowledgements or execution writes.

Use this credential to capture and compare a read-only migration inventory.
Issue a separate write-capable runtime credential only through the reviewed
provisioning and cutover process after outstanding legacy work and spending
have been reconciled.

Connector reads and writes are project- and site-scoped. Finding and Action
cursors are bound to the authenticated project, selected site and filters;
source rows are rechecked against the owning research run before they are
returned. Missing or malformed evidence references remain explicit in the
response. Context writes require the
registered canonical host and compare-and-swap revision. Preparation is
rejected unless current context and linked research evidence are fresh, the
target is in the canonical site inventory, and the owner executor supports the
required capability. A targetless content creation Action needs an explicit
bounded creation capability and acceptance criteria.

Every Action evidence source must resolve in the owning project and site and
must be fresh under both its research run's recency window and the current
policy's recency window. New research runs capture the policy revision used at
creation; Action envelopes report the sorted revisions represented by their
evidence (historical runs with unknown revisions are omitted). The envelope's
`contextRevisions.researchPolicy` is therefore an array of evidence revisions,
not a timestamp for the latest policy. `currentResearchPolicy` reports the
current revision separately, and each evidence row's `recencyLimitDays` is
the stricter of the run and current policy limits so a queued preparation can
recheck freshness immediately before candidate creation.

The transfer endpoint uses the separate provisioning control token; project
service credentials cannot change executor ownership. It requires the expected
executor and generation, a reason and idempotency key, no unacknowledged events,
no reserved or uncertain research spend, and no exact candidate waiting for an
owner decision. A successful transfer creates an immutable audit record and
outbox event while incrementing the generation fence in one transaction.

## Execution state

### Current Opportunity/Task workflow

New recommendation work uses `Opportunity` and `Task`, not `ResearchAction`.
The Action endpoints below remain for existing Action-bound work; they are not a
fallback or a second identity for a new Opportunity. The new capabilities are
`opportunities.read`, `opportunities.decide`, `tasks.read`, `tasks.confirm` and
`analytics.read`. Read operations require `connector:read`; human-decision writes
require `connector:write` and the active `helloada` binding generation.

Every new endpoint requires an explicit registered `siteId` in an active project
and workspace with an active connector binding. Opportunities belong to the
canonical project (the schema has no site-local Opportunity table). Returned
envelopes identify both the project and selected site; clients must verify those
identities. An Opportunity cursor is scoped to that same project.

Decision bodies contain `siteId`, `generation`, `idempotencyKey`, `confirmedBy`
(the stable human identity), and `confirmationRef` (the original authenticated
owner message/decision reference). A service credential delegates transport; it
does not turn an agent's judgment into a human confirmation. The receipt records
the human separately from the relaying service principal. Owner authentication
belongs to Site-Agent's existing owner-session/approval boundary: CrawlSEO trusts
the write-scoped executor's assertion and cannot independently authenticate a
conversation reference. These fields are an audit trail, not a new identity or
approval system. Do not expose this mutation as an unrestricted model tool.
Never manufacture a confirmation or replace the reviewed version with a fresh
read before writing.

Opportunity decisions additionally carry `operation` (`accept`, `park`, `reject`)
and `expectedUpdatedAt` from the reviewed Opportunity. A versioned recommendation
also carries its `expectedDecisionId`. Only detected or parked Opportunities can
be accepted/parked/rejected. Acceptance uses the shared task-creation gate inside
the receipt transaction; active work cannot be accepted again to create a second
Task. Generic decisions cannot bypass acceptance or directly close work.

Task confirmations additionally carry `opportunityId`, `expectedStatus`, and
`status`. The human flow is `todo → in_progress → delivered → verified_outcome`;
agent-prepared work may reach `awaiting_human`, which can progress to
`in_progress` or `delivered`. A closed Task cannot move backwards or skip delivery.
Delivered work marks its Opportunity delivered; verified work closes it. The
shared browser and connector services enforce scope, compare-and-swap, and atomic
Task/Opportunity progression. Outcome recording also progresses the Opportunity
in its transaction. A human-confirmed verification is not itself a claim of a
measured traffic/ranking win; measured observations remain separate records.

An exact request replay returns its durable receipt without reapplying the
transition or changing who confirmed it. Within each operation endpoint,
reusing a key for changed data conflicts. All accept/park/reject decisions share
the `opportunity.decide` key namespace; Task confirmations use `task.confirm`.
Stale versions, status conflicts and transferred executor generations return
409; cross-project targets return 404. No endpoint publishes a website.

### Existing Action-bound execution

The accepted preparation operation queues one Action revision. Site-Agent may
prepare a private candidate through the canonical Payload contract and return
its stable `candidateRef`, authenticated owner review URL and SHA-256 hash of
the exact review package. CrawlSEO accepts an owner decision only when the
candidate, review URL and package hash match that ready report. Publication
must carry the same review package hash. A publication receipt must
match the candidate reference and Action target and include a receipt ID,
publication time and content hash. Outcome measurements are accepted only
after verified publication. These receipts report state; they do not authorize
the next transition.

Each accepted preparation request has a unique `preparationRequestId` derived
from its operation idempotency key. HelloAda must echo it with `preparation_ready`
or `preparation_blocked`; CrawlSEO rejects reports from an earlier retry. A
network retry of the same owner click reuses the key, while a deliberate retry
after a blocked attempt creates a new key.

Events are at-least-once. `sequence` is project-wide and `after`/`nextCursor`
are advisory; polling returns due, unacknowledged events for the requested site
so gaps and restarts cannot hide receipts. Acknowledge exact event IDs only
after local persistence. Consumers persist the Action/binding or a bounded
diagnostic before acknowledging the event. Retries use exponential backoff;
operation idempotency keys must be stable for exact request retries and unique
when the request data changes. The connector execution generation fences stale
Site-Agent workers after a transfer.

## Google connection and analytics

Google authorization remains in the existing protected project-provisioning and
Google connection services. Provisioning registers encrypted service-account or
OAuth connections and site/property-specific GA4/GSC grants, and queues the
existing GA4/GSC sync jobs. Google property access must actually be granted to
that identity; an identifier alone is not authorization. The connector never
accepts or returns Google credential material, provisions alternative grants, or
starts a sync from a GET.

`/analytics` projects saved `AnalyticsSnapshot` and GSC query/page observations.
The optional date pair selects a range of at most 366 days (default: the last 90
completed UTC days). GA4 reports the selected snapshot's own coverage; a snapshot
overlapping the requested range is not a full-range aggregate. Missing data stays
unavailable, never synthetic zeroes. Availability, connection health and sync
health are distinct, so retained observations do not hide a failed connection.
Multiple non-revoked Google grants produce `connection.status: ambiguous`,
`errorCode: MULTIPLE_GOOGLE_GRANTS`, and a null `propertyId`; the connector does
not choose a healthier credential or label saved observations as belonging to
one property. Saved, site-scoped observations remain readable independently of
that connection error. Repair the grants through the existing provisioning
service, not through the analytics read endpoint or an ad-hoc database update.
GSC bounded detail reads report their full row counts and omitted-row counts.
Clients must not calculate full-property totals from a truncated detail list.

This source contract is not evidence of deployment, a tenant's Google access, or
Growth UI adoption. Those require the normal release and authenticated tenant
verification. No live grants, research budgets or customer state are changed by
the implementation itself.

## Research limits

`ResearchPolicy.monthlyBudget` is a maximum number of research runs created in
the project's configured IANA timezone calendar month, including scheduled
and failed runs. `maxSources` limits
saved sources per run. Unsupported providers are reported explicitly; they do
not silently produce results. This run-count limit is separate from the
HelloAda paid-provider allowance ledger, which reserves and settles billable
DataForSEO work before/after provider dispatch. The shared budget policy also
requires an explicit per-operation reservation ceiling for paid requests. The
DataForSEO worker requires a USD policy so provider receipts are not compared
against another currency without conversion. An uncertain provider response
remains held until its actual receipt is reconciled.

The currently implemented execution adapters are `helloada` and
`crawlseo-agent`. Provisioning and executor transfer reject `wix` and `webflow`
until each platform adapter has passed its preparation, owner-review, receipt
and verification pilot. The capability response lists the implemented set;
existing unsupported bindings cannot accept preparation or execution reports,
and the protected migration inventory blocks their cutover. HelloAda's declared
`site_metadata.robots` and `site_metadata.sitemap` capabilities are restricted
to the exact source paths and canonical routes supplied by its current site
context. Source-file Actions must cite one of those exact paths, request the
matching capability, and target `/robots.txt` or `/sitemap.xml` on the canonical
origin. The declaration is a narrow HelloAda capability and does not advertise
general source-code execution for other connectors.

The current RSS runner plans at most five normalized topic/question queries,
records each query and its basis in the run report, applies topic and domain
exclusions, and uses the stricter run/current-policy recency window before
synthesis. Runs report collected, excluded, eligible, capped and saved source
counts, including missing, invalid, future and stale publication dates. A run
with no eligible saved sources finishes as partial without generating findings
or Actions. `publishedAt` is required for current-evidence eligibility; missing
publication dates remain visible in the quality counts instead of being called
fresh.

Apply the Prisma migration before provisioning connector credentials. Do not
backfill customer workflow state or activate a connector against a customer
site as part of a code-only rollout; use the registered migration and release
gates for that work.

## Technical crawl evidence reassessment

Technical crawl observations use the separate versioned `technicalEvidence`
contract (`schemaVersion: 1.0`, `sourceKind: crawl`). It identifies one exact
completed crawl and persisted CrawlIssue and AuditPage IDs, the registered site,
the current canonical context revision, and a seven-day observation limit.
These references are not ResearchSource records and do not assert research
freshness. The connector resolves each reference against the selected site's
database rows before returning it as complete. Legacy crawl Actions are never
backfilled by matching titles, URLs, or dates.

**Retired in wave 6.** The protected provisioning endpoint
`POST /api/internal/sites/{siteId}/technical-actions/reassess` answers `410 Gone`.
Technical reassessment now happens in the funnel: a crawl refreshes the evidence
store and the O7/O8 detectors raise or re-score the opportunity themselves, so no
legacy Action is created or revised. The paragraph below is kept as the record of
what the endpoint did while it existed.

It accepted an exact crawl ID and unique issue IDs. Reassessment requires an active `helloada`
binding, current context, an explicit operator request ID and reason, and an
exact group of persisted issue IDs. Reusing an operator request ID with changed
inputs conflicts. Updating a legacy Action requires its explicit ID and current
revision, and is blocked if it has review, preparation, execution, candidate,
delivery, draft, owner-decision, or active task state.

Preparable targets are limited to exact robots/sitemap source files with their
declared metadata capability, or one current Payload route with
`content.prepare` for missing or duplicate title and description observations.
The content proposal names one exact target page; duplicate-group evidence does
not claim that editing one page resolves the other pages. Other technical issue
types remain evidence for assessment only and cannot be converted into a
Payload preparation. This path does not grant research or paid provider
authority.
