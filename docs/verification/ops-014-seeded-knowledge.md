# OPS-014 production verification — loop evidence and remaining gaps

The test project's canonical profile is stored and revision 2 is accepted using
the requested internal service-side path. A subsequent documented crawl
completed. It produced crawl evidence, including a schema-semantics finding, but
not a business-content mismatch or a business-gap Action. The authenticated
Intelligence page was fetched after the crawl and does not render the profile or
Actions.

## Target and canonical profile

- Project `Ada Provisioning Test` (`ada-provision-test`, ID
  `cmuls0r2n0002oyqfmv86i92z`); workspace `helloada` (ID
  `cmuls0r2f0000oyqfhaaaf7fp`, external organization ID `helloada`); site
  `ada-provision-test.helloada.app` (ID `cmuls0r2v0004oyqfcbjnqwxq`). The site
  domain was subsequently repointed to `crawlseo.helloada.app` for this test.
- The initial authenticated document read returned `NOT_FOUND`. The documented
  knowledge write created logical document `business-profile`, revision 1,
  with the six requested profile fields. Positive facts are `internal_only`;
  the prohibited claim is `prohibited`; no fact is marked publishable/approved.
- Revision 1 used actor `ops014-verification` as supplied in an earlier
  instruction. A production User lookup showed that ID does not exist, but the
  API accepted and persisted it. This is a provenance-validation gap. Revision
  1 is immutable and retains that invalid actor.
- Revision 2 was written with existing admin User ID
  `cmtbmqohh0000oymfyormqpt2` on every fact. Production state is **1 document,
  2 revisions**.

## Acceptance

- `acceptedRevision` is **2**. Acceptance was recorded by a one-off script
  calling the canonical `acceptBusinessKnowledge` service function with the
  authenticated project principal, actor ID `cmtbmqohh0000oymfyormqpt2`, and
  the test-only reason. This is the service-side path SOL explicitly directed
  for this internal project; it did not mint or present a HelloAda owner proof.
- The HTTP `document_accept` API refuses `workspace_admin` (403); the dashboard
  route requires a user linked as owner of every site, while this site has
  `userId: null`. Thus acceptance of this internal project currently has no
  dashboard equivalent. The direct function records the acceptance actor type
  as `owner`; do not interpret this service-side test acceptance as a verified
  HelloAda owner-authentication event.

## Crawl and persisted audit evidence

- Documented MCP entrypoint `seo_run_crawl`; job
  `cmvqp3yjf0003oyufjcvddie9` completed in one attempt. Crawl
  `cmvqp3yr1000foyc17dnc15bj`: **COMPLETED**, 1 page, 4 issues.
- Issues by `CrawlIssue.type`:
  - `BROKEN_LINK`: 1 (`CRITICAL`).
  - `MISSING_SITEMAP`: 1 (`WARNING`).
  - `MISSING_SCHEMA`: 2 (`INFO`), one business semantics finding and one crawl
    summary finding.
  - Total: **4**. `MISSING_ROBOTS`: 0.
- The business semantics issue is `MISSING_SCHEMA`,
  `details.kind=business_schema_semantics`, `field=structuredData`,
  `status=unknown`; its evidence is “No JSON-LD structured data was present to
  compare.” This is not a positive business-content mismatch: without JSON-LD,
  the audit could not compare the accepted facts against structured data.
- SOL later confirmed the previous test host did not resolve (HTTP 000), and
  repointed it. The earlier job's three automatic attempts ended in failed
  zero-page crawls; the successful crawl above is after that site change.

## Actions and verifiers

- The successful crawl generated **1** new Action, kind `fix_technical_issue`,
  source `crawl_issue`, status `PROPOSED`, for the broken-link issue. Its
  verifier is type `crawl_issue_absence`, identity
  `BROKEN_LINK:broken:404:home`, check “The next completed crawl must not
  report this issue identity for these URLs.” No verifier result exists yet;
  the Action is unverified.
- It generated **0 business-content/schema-semantics Actions**. The
  `ResearchAction` schema has no dimension column; its available classification
  here is `kind`. The semantic issue above has evidence but no corresponding
  Action/verifier. Three pre-existing technical Actions remain; they are not
  outputs of this crawl.

## Authenticated Intelligence page render

- Fetched
  `https://crawlseo.helloada.app/crawlseo/sites/cmuls0r2v0004oyqfcbjnqwxq/intelligence`
  with HTTP 200 using a temporary five-minute Session for the specified real
  admin user. The row was deleted in `finally` and a follow-up count found zero
  unexpired sessions for that user. HTML was retained outside the repository
  at `/home/admin/releases/ops014-intelligence-final.html` (not committed).
- The rendered page shows **AI access readiness** (no blocking robots issue;
  sitemap “Not found by crawl”; page responded during crawl), **Visibility
  observed** (“Nothing observed yet”), **Questions** (“No question coverage
  recorded”), and **Sources** (“No research sources yet”). It does not show
  `business-profile`, revision 2, the semantic finding, or any Action.
- Exact UI gap: `app/(dashboard)/sites/[siteId]/intelligence/page.tsx` only
  queries latest completed crawl, AI visibility observations, question
  coverage, and research sources (queries at lines 15–19). It queries neither
  `BusinessKnowledgeDocument`/`BusinessKnowledgeRevision` nor
  `ResearchAction`, and renders no profile revision, audit issue evidence, or
  Actions. This is the reported UI-029 gap; production was not hand-patched.

## Still absent

The semantic finding did not produce a gap Action; the page does not surface
knowledge or Actions; question coverage still needs a draft approval; visibility
still needs an export. The initial invalid actor remains in immutable revision
1 and the service-side acceptance does not prove owner authentication. No code
tests were run; this PR changes verification documentation only.
