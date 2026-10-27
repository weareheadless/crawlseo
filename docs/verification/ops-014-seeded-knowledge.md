# OPS-014 production verification — partially complete, blocked before crawl

**Status: incomplete.** One working knowledge revision was written through the
documented HTTP API. No crawl was started, no gap Actions were produced, and the
Intelligence page was not authenticated/rendered. The AEO loop is not verified.

## Target and recorded profile

- Production project: `Ada Provisioning Test` (`ada-provision-test`, ID
  `cmuls0r2n0002oyqfmv86i92z`); workspace `helloada` (ID
  `cmuls0r2f0000oyqfhaaaf7fp`); site `ada-provision-test.helloada.app` (ID
  `cmuls0r2v0004oyqfcbjnqwxq`).
- `GET /crawlseo/api/projects/knowledge` returned `NOT_FOUND` before writing.
- `POST /crawlseo/api/projects/knowledge` returned HTTP 200 for logical
  document `business-profile`, revision 1, state `working`, with no accepted
  revision. It records all six requested dimensions: business name, location,
  services, differentiator, audience motivation, and prohibited claim. Every
  positive fact is marked `internal_only`; the prohibited claim is marked
  `prohibited`. No fact was marked publishable/approved.
- The request used idempotency key `ops014-ada-provision-test-seed-20261027-v1`
  and the stated reason labels it an internal test-business profile.
- A subsequent authenticated API read returned revision 1 and these fields.
  Production DB counts after the write: **1 document, 1 revision**.
- The supplied `actor.id` (`ops014-verification`) does not match a row in the
  production `User` table (read-only check). The API nevertheless accepted and
  persisted it as `workspace_admin` provenance. Therefore the requested “real
  actor” condition is **not proven**; do not describe that provenance as
  verified.

## Why the crawl and UI checks stopped

1. The supplied credential carries `project:read`, `document:read`, and
   `document:write`, but not `crawl:run`. The documented MCP `seo_run_crawl`
   tool was invoked once with the project credential and returned
   `Service credential lacks required scope`; no crawl was queued. The site
   session route cannot be used without a real authenticated user, and no owner
   is linked to this site.
2. Even with crawl permission, `lib/crawler/engine.ts` reads only the accepted
   canonical revision (`acceptedRevision`) for its semantic audit. This write
   produced a working revision with `acceptedRevision: null`, so a crawl now
   would report knowledge unavailable, not compare against the seeded profile.
   The acceptance contract requires a verified owner proof; this project's
   external organization is `helloada`, and the project has no linked site
   owner. Do not forge acceptance or insert it directly in the database.
3. `app/(dashboard)/sites/[siteId]/intelligence/page.tsx` reads latest crawl
   access issues, visibility observations, question coverage, and research
   sources; it does not query/render business knowledge revisions or Research
   Actions. Thus it cannot currently prove the requested profile-revision and
   gap-Action display. No session was minted or left behind.

## Counts and remaining work

- Knowledge documents/revisions: **1 / 1** (working, not accepted).
- New crawl issues by kind: **0** (no new crawl). A pre-existing completed
  crawl from 2026-10-23 has 4 issues; these predate the knowledge write and are
  not evidence for OPS-014. No post-seed crawl issue evidence is claimed.
- New gap Actions by dimension: **0**. Three pre-existing project Actions are
  `fix_technical_issue`, not Actions generated from the knowledge audit.
- Still absent: accepted owner-authorized knowledge, a crawl against that
  accepted revision, audit evidence, gap Actions/verifiers, authenticated
  Intelligence rendering, question coverage (requires draft approval), and
  visibility export.

## Exact defects / required follow-up

- `app/api/projects/knowledge/route.ts` authenticates the service scope and
  passes caller-supplied `changes` directly to `writeBusinessKnowledge`; that
  function validates fact shape but does not establish the supplied provenance
  actor. This contradicts `docs/business-knowledge-writers.md`'s statement that
  caller JSON cannot claim owner authority. The successful write with an
  unresolvable `workspace_admin` actor demonstrates this mismatch. Do not
  hand-repair production; reconcile the already-recorded provenance via the
  approved audit/repair path.
- The test project's usable acceptance path and project identity need to be
  reconciled with the owner-proof contract before semantic crawl verification.
- The Intelligence page requires a product change to display the requested
  knowledge revision and resulting audit/Action items. That code change is out
  of this production-verification scope; do not hand-patch production.
- Issue a deliberately scoped `crawl:run` credential only after the accepted
  knowledge path is available, then rerun the documented MCP crawl and verify
  its persisted issues and Actions end to end.
