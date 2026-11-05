# Recommendation migration residual repair — 2026-11-04

## Scope

This patch closes the ten residual gaps in
`docs/recommendation-migration-completion-review-2026-11-04.md`:

- **G1** complete inventory pagination and title/body search;
- **G2** bounded client-side rendered retrieval;
- **G3** monthly-cycle tenant bootstrap;
- **G4** empty/unusable business knowledge;
- **G5** shared production/evaluation bootstrap;
- **G6** seeded desktop/mobile browser and accessibility review;
- **G7** complete shadow diff with a distinct `not_assessed` state;
- **G8** shadow input/output destination validation;
- **G9** scoped snapshot/restore;
- **G10** shadow→apply equivalence on a disposable schema.

No live model/provider calls, application-database migration or write, publication,
merge or deployment were performed. Database tests used `schema=csv_validation`.

## G1 — complete inventory and search

**Before.** `loadInventory` took the first 500 rows ordered by URL, and
`inventory_search` matched only URL substrings against that projection. A page
beyond 500, or an arbitrary URL whose body answered the question, was invisible.

**Fix.** `lib/recommendation/packet.ts`

- Reads the whole crawl in 500-row cursor batches and stops on a missing or
  repeated cursor.
- Keeps the model-visible inventory bounded at 2,000 rows and reports the
  difference explicitly.
- Keeps an in-process row index for the service-side resolver, outside the
  serialized packet.
- `lib/recommendation/contracts.ts` searches URL, title and a bounded body excerpt
  for `inventory_search`, scoring all matched terms and selecting the best match.
- `lib/recommendation/run.ts` passes the full index into request validation.

**Tests.** `tests/recommendation-inventory.test.ts`

- 1,201 rows are all read, including the last page.
- An arbitrary page beyond the packet projection is found by body text.

## G2 — rendered retrieval

**Before.** A client-rendered shell was marked unavailable and never rendered.

**Fix.** `lib/recommendation/packet.ts`

- Reuses the existing Chromium discovery in `lib/agent-tasks/screenshots.ts`.
- On a shell or sub-80-character extraction, performs one bounded headless render
  of the already-validated final URL.
- Records retrieval `rendered`, final URL, status, supplied-text hash, total
  characters, truncation and a render note; charges the bytes and one fetch
  attempt.
- A failed or unavailable render remains `unavailable`, not proof of absence.
- `run.ts` accepts rendered pages for reuse only when they are not truncated.

**Tests.** `tests/recommendation-rendered.test.ts`

- A shell quote page is read through the injected render seam.
- A missing render stays unknown.

## G3 — monthly tenant bootstrap

**Before.** `runMonthlyCycle` skipped research when topics were empty, and
`ensureTenantAnalysis` ran only after a scheduled research run. A new tenant with
no profile, knowledge or topics could never start its monthly analysis.

**Fix.** `lib/jobs/monthly-cycle.ts`

- Runs `ensureTenantAnalysis` with `bootstrapOnly: true` and `skipResearch: true`
  before the crawl/research stages.
- Re-reads the site profile after bootstrap, so derived topics are used by the
  research stage in the same cycle.
- Keeps the existing idempotence: the second cycle finds the run and skips it.

`lib/tenants/analysis.ts` gains `dryRun`, `skipResearch` and `bootstrapOnly`
options, plus an `extraction` result.

**Tests.** `tests/monthly-cycle-bootstrap.test.ts`

- A new tenant is bootstrapped, topics are derived and research is queued.
- A dry run does not bootstrap.

## G4 — empty or unusable knowledge

**Before.** A `BusinessKnowledgeDocument` row was treated as usable even when its
latest revision had no facts.

**Fix.** `lib/tenants/analysis.ts`

- Inspects the latest revision fields.
- Treats a document with no non-empty fact (ignoring `contentLanguage`) as
  `missing`, so the existing bootstrap runs.
- Preserves accepted revisions and owner facts.

**Tests.** `tests/tenant-bootstrap.test.ts`

- A document containing only `contentLanguage` is reported as unusable.
- A document with a service fact is `ok`.

## G5 — shared evaluation bootstrap

**Before.** The evaluation script called `extractBusinessKnowledgeFromSite`
directly, with a different orchestration from the monthly path.

**Fix.** `scripts/evaluate-need-assessment.ts`

- Calls `ensureTenantAnalysis(db, siteId, { dryRun: true })`.
- Uses `analysis.extraction` for the evaluation facts.
- Keeps the evaluation read-only.

**Tests.** `tests/tenant-bootstrap.test.ts`

- The evaluation source uses `ensureTenantAnalysis` and no longer imports the
  extractor directly.
- The dry-run path returns extraction and does not write a site profile.

## G6 — browser and accessibility

**Fix.** `scripts/browser-review.ts`

- Seeds an isolated workspace, user, session, site, business knowledge and two
  canonical opportunities: an investigation and an actionable recommendation with
  two benefits and two review requirements.
- Starts the built app against the disposable schema and opens the detail pages at
  desktop (1440×1200) and mobile (390×844).
- Sets the real session cookie, checks horizontal overflow, runs axe-core, saves
  screenshots and a JSON report, then deletes the workspace.

**Fixes found by the check.**

- `components/layout/app-shell.tsx`: labelled the brand link, mobile menu and
  mobile close buttons.
- `components/funnel/decision-summary.tsx`: source links are underlined, not
  distinguished by colour alone.

**Run.**

```
npx tsx scripts/browser-review.ts --database-url="...?schema=csv_validation" \
  --out-dir=/tmp/opencode/browser-review-3
```

Result: exit 0; no axe violations; no horizontal overflow. Artifacts:
`/tmp/opencode/browser-review-3/report.json` and four PNGs.

## G7 — complete shadow diff

**Before.** Shadow capped assessments at 8 (max 12) and labelled every unassessed
candidate `failed` with a budget message.

**Fix.** `lib/recommendation/shadow.ts`

- Adds `not_assessed`, distinct from `failed`.
- Adds `complete`, `candidateCount`, `assessedCount`, `notAssessedCount` and a
  `budget` block.
- Supports `maxAssessments: "all"`; numeric values remain capped at 12.
- Reports preserved task identity: task id, status, decision id and plan hash.

**Tests.** `tests/shadow-completeness.test.ts`

- 15 candidates with a cap of 8: 8 assessed, 7 `not_assessed`, no failures,
  `complete: false`.
- All mode: 15 assessed, `complete: true`.

## G8 — shadow destination validation

**Fix.** `lib/recommendation/shadow-destination.ts`

- Output must be absolute, end in `.json`, be outside the repository, and be inside
  `/tmp/opencode` (or `SHADOW_OUTPUT_ROOT`).
- Existing files require explicit overwrite; directories are refused.
- The database URL must name a non-public schema, use a safe schema name and not
  equal the application URL.
- `shadowRecommendations` validates the output before any work.
- `scripts/shadow-recommendations.ts` requires `--database-url` or
  `SHADOW_DATABASE_URL`, opens that URL itself, and exposes `--all` and
  `--overwrite`.

**Tests.** `tests/shadow-destination.test.ts`

- Relative, repository, unapproved-root and existing paths are refused.
- Public/schema-less/application database URLs are refused.
- A valid `/tmp/opencode` path and disposable URL pass.

## G9 — scoped rollback

**Before.** A snapshot covered every active site and restore rewound every site in
the file.

**Fix.** `lib/ops/board-snapshot.ts`

- Snapshots record `scope` (`projectId`, `siteId`, `runId` or `all`).
- `takeBoardSnapshot` accepts a scope.
- `restoreBoardSnapshot` requires an explicit project/site scope or `all: true`;
  it refuses a mismatched run/project/site and reports out-of-scope sites as
  `skipped`, leaving them unchanged.

**Tests.** `tests/board-snapshot.test.ts`

- An unscoped restore is refused.
- Restoring one project touches only that project and reports the other as skipped.
- Existing all-site integration snapshots pass `{ all: true }`.

## G10 — shadow→apply equivalence

**Fix.** `lib/recommendation/projection.ts`

- The projection now computes the same `computeScore` inputs that
  `upsertOpportunity` stores, including `evidenceCompleteness` and the assessment
  fields.
- Publish uses `evidenceCompleteness: "why"`; shadow uses the existing opportunity’s
  completeness for the current row and the applied leg for the proposal.

**Test.** `tests/customer-recommendations-postgres.integration.test.ts`

- Seeds a tenant, finding and evidence.
- Runs shadow with an injected actionable decision and asserts the opportunity
  count did not change.
- Applies the same decision through `publishDecision` and compares the stored row
  to `proposedProjection` (title, summary, type, score inputs, decision).
- Applies a second time and asserts one row.

## Verification

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'` | 1,058 passed / 21 skipped, exit 0 |
| `DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run tests/customer-recommendations-postgres.integration.test.ts` | 9 passed, exit 0 |
| `npm run build` | exit 0, compiled successfully |
| `npx tsx scripts/browser-review.ts ...` | exit 0, 0 axe violations, no overflow |

The full suite initially OOM'd because a fixture ignored the new inventory cursor.
`loadInventory` now stops on a missing or repeated cursor; the targeted test and
the full suite then passed.

## Remaining gates

- **Package 6 Track A:** the historical evaluation manifest and saved attempt
  artifacts are not yet packaged; live model calls require the approved manifest.
- **Package 6 Track B:** the held-out tenant still needs authorised research
  acquisition before fresh monthly discovery can run.
- **Independent SEO/business review:** not performed.
- **Package 7:** the handoff needs a full corrected completion audit; the old
  document has a correction notice.
- **Production migration, shadow/apply reassessment, publication, merge and
  deployment:** not authorised and not performed.

The green engineering totals do not prove SEO usefulness or independent approval.
