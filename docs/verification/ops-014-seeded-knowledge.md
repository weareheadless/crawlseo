# OPS-014 production verification — incomplete

The business profile is stored in production, but OPS-014's audit/action loop is
not verified. Owner acceptance is blocked by the current test-project identity
and acceptance contract; all three automatic worker attempts for the requested
crawl failed before producing issues. The authenticated Intelligence page was
fetched and confirmed not to render the profile revision or Actions.

## Target and profile writes

- Production project: `Ada Provisioning Test` (`ada-provision-test`, ID
  `cmuls0r2n0002oyqfmv86i92z`); workspace `helloada` (ID
  `cmuls0r2f0000oyqfhaaaf7fp`, external organization ID `helloada`); site
  `ada-provision-test.helloada.app` (ID `cmuls0r2v0004oyqfcbjnqwxq`).
- Initial authenticated `GET /crawlseo/api/projects/knowledge` returned
  `NOT_FOUND`. The documented `POST /crawlseo/api/projects/knowledge` wrote
  logical document `business-profile`, revision 1, working. The profile names
  this as an internal verification fixture and records the requested six
  fields. All ordinary facts are `internal_only`; the prohibited claim is
  `prohibited`; none is marked publishable/approved.
- The initial write used actor `ops014-verification`, as supplied in the
  earlier instruction. A read-only production User lookup established that ID
  is not a `User` row. The API nonetheless persisted it as `workspace_admin`.
  This is an observed provenance-validation gap; the value is not considered a
  verified actor and has not been used again.
- Revision 2 was written with the specified, existing admin User ID
  `cmtbmqohh0000oymfyormqpt2` on all six facts. Revision 2 remains working and
  `acceptedRevision` is null. The original revision is immutable and still
  contains the invalid actor ID. Production counts: **1 document, 2 revisions**.

## Acceptance boundary

- A documented `document_accept` request with actor type `workspace_admin` and
  the verified admin ID returned HTTP 403:
  `Workspace-admin acceptance is not supported through the project API; use the
  authenticated dashboard workflow`. No acceptance was written.
- The project has no site-linked user (`Site.userId` is null). The dashboard
  correction route requires the signed-in user to own every site in the
  project, so it cannot supply the fallback for this project.
- The owner proof verifier requires the proof's external organization to equal
  `helloada:<actorId>`, while this project's registered external organization
  is `helloada`. No HelloAda owner proof was available, and the verified actor
  supplied is an admin, not an owner. Do not mint or fabricate an owner proof.
- `lib/crawler/engine.ts` (`/* Compare published pages with the accepted
  canonical knowledge document */`) reads only `acceptedRevision`; there is no
  documented working-revision audit mechanism. The authorized project token
  therefore cannot make this working document eligible for semantic audit.

## Crawl and artefact counts

- The documented project MCP `seo_run_crawl` entrypoint accepted job
  `cmvqopmi30001oyufid44wyqx` (`site_id` above). The worker made its configured
  three attempts; all ended `JOB_EXECUTION_FAILED`. Crawl records:
  - `cmvqopn0b0003oyc1u2i0i0yv` — FAILED, 0 issues.
  - `cmvqorylk0007oyc1uymind6f` — FAILED, 0 issues.
  - `cmvqovkn8000boyc175e5omqb` — FAILED, 0 issues.
- New crawl issues by kind: **none (0 total)**, including
  `business_schema_semantics` findings. The last completed pre-seed crawl,
  `cmvl9q9rm0frsoy0kpw4xv3de` (2026-10-23), had 1 each of `BROKEN_LINK`,
  `MISSING_ROBOTS`, `MISSING_SITEMAP`, and `MISSING_SCHEMA`, and 0 business
  semantic findings. It predates the profile and is not OPS-014 evidence.
- New knowledge-gap Actions by dimension: **none (0 total)**; consequently
  there are no resulting verifier identities to report. Three pre-existing
  project Actions are all `fix_technical_issue` / `crawl_issue`; none has a
  persisted verifier identity/result. No Actions were produced by these failed
  crawls.
- The worker's `scripts/job-worker.ts` catch maps uncaught crawl errors to the
  generic `JOB_EXECUTION_FAILED` and does not log the underlying exception.
  `SyncRun.errorText` also contains only that generic code. The exact underlying
  crawl failure is therefore not recoverable from the persisted diagnostic;
  do not retry manually or claim a cause. This diagnostic gap needs a code fix
  before a safe retry.

## Authenticated Intelligence render

- Fetched
  `https://crawlseo.helloada.app/crawlseo/sites/cmuls0r2v0004oyqfcbjnqwxq/intelligence`
  with HTTP 200 using a temporary five-minute `Session` for the specified real
  admin user. The session row was deleted in `finally`; a follow-up query found
  zero unexpired sessions for that user. The HTML evidence was kept outside the
  repository at `/home/admin/releases/ops014-intelligence.html` (not committed).
- Rendered sections include **AI access readiness**, **Visibility observed**,
  **Questions**, and **Sources**. It showed “No question coverage recorded” and
  “No research sources yet”. It did **not** show `Ada Provisioning Test`,
  `business-profile`, a knowledge revision, or any Actions.
- Exact rendering gap: `app/(dashboard)/sites/[siteId]/intelligence/page.tsx`
  only loads a completed crawl, visibility observations, question coverage,
  and research sources (Promise queries at lines 15–19). It has no
  `BusinessKnowledgeDocument`/`BusinessKnowledgeRevision` query and no
  `ResearchAction` query/render. This requires a separately scoped code change;
  production was not hand-patched.

## Outstanding acceptance gaps

Acceptance/owner identity must be reconciled for this registered project before
the profile can be audited; crawl failures need root-cause diagnostics and a
fix before another execution. Then rerun one documented crawl and prove
business-content/schema findings and verifier-bearing gap Actions. The
Intelligence page requires the separately scoped rendering change. Question
coverage still needs a draft approval; visibility still needs an export.
