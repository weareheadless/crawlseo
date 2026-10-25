# Site-Agent connector contract

CrawlSEO is the shared research authority for a project. Site-Agent remains
the only owner-facing approval and website executor when a site's binding is
`helloada`. The connector never publishes content.

## Authentication and scope

Provision one service credential for the project with `connector:read` and
`connector:write`. Send it as `Authorization: Bearer <token>` to
`/api/connector/v1/*`. Credentials are project-scoped, stored as hashes, and
must not be exposed in browser code or logs. The provisioned connector binding
contains the active executor and a monotonically increasing generation; every
write carries that generation so a transferred or stale executor is rejected.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/capabilities?siteId=…` | Read schema version, the selected site's active binding and supported operations. |
| GET, PUT | `/context?siteId=…` | Read or compare-and-swap the current site inventory, business facts, origin and capabilities. |
| GET | `/findings?siteId=…&runId=…` | Read project/site-scoped findings with source lineage and linked Action revisions, using a bounded cursor. |
| GET | `/actions?siteId=…` | List current site Actions, bounded to 100 per request. |
| GET | `/actions/{actionId}?siteId=…` | Read one current Action envelope and its linked evidence/execution state. |
| POST | `/actions/{actionId}/operations` | Accept/decline preparation, request correction, or cancel preparation with expected revision, generation and idempotency key. |
| POST | `/actions/{actionId}/execution` | Record preparation, owner-decision, publication and outcome states. |
| GET, POST | `/events?siteId=…` | Poll the selected site's at-least-once event outbox, acknowledge durable local receipts, or schedule retry with backoff. |
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
