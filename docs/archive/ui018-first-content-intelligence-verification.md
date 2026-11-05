# UI-018 first content-intelligence verification

This report is a local, disposable-fixture verification increment, not a release qualification. The executable integration test is `tests/ui018-content-intelligence-postgres.integration.test.ts` and is enabled only with `RUN_UI018_DB_TESTS=1` against a local `codex` database whose name ends `_validation`.

## Proven by this fixture test

The test exercises CrawlSEO services for domainless HelloAda project registration, configured bounded USD research budget, owner-confirmed intake facts and knowledge revision readback, prelaunch research execution with the DataForSEO client stubbed at its network boundary, replay idempotency, question coverage, and schema-semantics comparison against inline fixture HTML/JSON-LD. The five-keyword research package invokes exactly five stub operations. It checks that replay creates no additional run/job and no additional budget reservations and invokes no additional provider operations. Question coverage uses its existing site-scoped `ResearchRun` contract, so the fixture creates an isolated synthetic site only after verifying domainless prelaunch research; this is not a customer site. It asserts the projected consumer document is exactly `{documentId, revision, state, fields}` and retains the same revision/fields.

The site-agent design-context projection is not implemented or tested here. Its implementation and tests are in site-agent PR #348 (merged); this test validates only CrawlSEO's consumer-facing shape and revision references.

## Explicitly not proven

- No live provider call or paid dispatch: the provider is stubbed; fixture cost is not a real charge.
- No customer tenant, credentials, production database, publication, or tenant migration.
- No owner-facing design journey or rendered design candidate; no claim of end-to-end product readiness.
- No live site schema audit: the audit consumes fixture page markup only.

## Remaining gates and closing checks

1. **Provider integration:** run the existing authenticated provider connectivity and bounded budget check in an explicitly authorized non-customer test account; inspect provider task receipt and reservation/settlement. This repository has no safe local live-provider prerequisite, so this test intentionally cannot close the gate.
2. **Cross-repository projection:** run the site-agent #348 `DesignSharedIntelligence` focused tests at the merged commit, then compare its actual projection against this tested `{documentId, revision, state, fields}` boundary. No site-agent checkout or its test command is available from this CrawlSEO test; cite its CI result/commit in the integration record.
3. **Customer tenant and owner journey:** requires an explicitly authorized registered test tenant, authenticated owner session, exact approved release and the normal tenant release/live-verification receipt. Then inspect the actual Design review surface and verify its candidate and carried revision. No such tenant/session is available or authorized by this issue; do not infer success from this fixture or public health.
4. **Live schema-semantics audit:** requires a published page on that authorized test tenant and canonical accepted business knowledge; run the existing audit against the fetched page through the normal crawler and inspect persisted findings. Fixture HTML is not evidence of live correctness.

Run locally with the disposable database and commands recorded on the PR; skipped DB suites are not represented as passing runtime integration evidence.
