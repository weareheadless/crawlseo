# OPS-014 production verification — blocked before seed

**Status: blocked; no production writes or crawl were performed.** This records
the exact precondition failure, not a successful AEO loop.

## Environment and baseline

- Repository baseline and contract pin: `81ad3e6b44444c8283ad2099b1aa047ce304d6c6`.
- The project was queried from the production database configured by
  `/SEO/.env.local`; its values were not emitted or recorded.
- `ada-provision-test` resolves to project `cmuls0r2n0002oyqfmv86i92z`
  (“Ada Provisioning Test”), workspace `cmuls0r2f0000oyqfhaaaf7fp`
  (`helloada`), and site `cmuls0r2v0004oyqfcbjnqwxq`
  (`ada-provision-test.helloada.app`).
- The project has no `BusinessKnowledgeDocument` and no revisions (0/0).
- Its site has no linked owner user (`userId` is null), so there is no real
  owner actor available for `admin_input` provenance through the authenticated
  dashboard correction route.
- The extant project service credential is active but its scopes are
  `seo:read`, `seo:research:request`, `analytics:read`, `crawl:read`, and
  `crawl:run`; it does not carry `document:write`.
- Three existing project `ResearchAction` rows were observed before any action
  was taken. No new Actions, audit results, or crawl were produced by this run.

## Why verification stopped

The documented business-knowledge API requires an existing credential with
`document:write` (`docs/business-knowledge-writers.md`,
`app/api/projects/knowledge/route.ts`). The only existing project credential
does not have that scope. The dashboard correction route instead requires a
signed-in user who owns every project site; this site has no owner user. The
other documented registration/recovery paths require a project-registration
receipt/proof, which was not established for this project. Re-provisioning the
project or creating/updating credentials directly in the database would bypass
those contracts, so neither was attempted.

No profile, fabricated actor, credential, session, or crawl was created. In
particular, no `publicationUse: approved` facts were asserted. The intended
profile fields, audit evidence, gap Action verifiers, and Intelligence page
render are consequently unverified. Question coverage still needs a draft
approval; visibility still needs an export. The absent document-write
authorization and owner identity must be resolved through the supported
provisioning/registration path before this production verification can proceed.
