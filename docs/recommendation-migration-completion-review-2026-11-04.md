# Recommendation migration completion review — 2026-11-04

> **Repair status (2026-11-04):** the ten gaps G1–G10 below have been repaired and
> verified. See `docs/recommendation-migration-residual-repair-2026-11-04.md`.
> The verdict and gap descriptions in this document are the pre-repair review;
> package 6 live evaluation, independent review and package 7 rollout remain gated.

## Verdict

The safety, lifecycle and shadow/rollback repairs are real and currently verified at
`36e7e46`. The migration is **not** complete.

- **Packages 1–5:** implemented and substantially tested, but not fully accepted. The
  checkboxes in the canonical plan are not acceptance evidence. Four package 2
  behaviours and five package 5/4 checks still have concrete gaps (below).
- **Package 6:** the evaluation harness and manifest are not finished. Live model calls
  and authorised research acquisition remain gated by a separate approval.
- **Package 7:** the handoff is stale. It reports `982 passed / 16 skipped`, predates the
  R7/R8 repair, and describes the old rollback behaviour. It must be rewritten, not
  merely appended to.

Do not tick packages 1–5 again, and do not claim “complete except review”, until the
gaps in this document have failing-before/passing-after evidence.

## What is actually verified now

Current HEAD: `36e7e46`. Working tree clean.

| Area | Evidence | Status |
|---|---|---|
| Safety findings 1–7 and fairness | `dfefa00`, `828ed5c`; `docs/recommendation-analysis-safety-252df72-repair.md` | Repaired |
| R7 lifecycle/acceptance | `36e7e46`; `tests/recommendation-lifecycle.test.ts`, `tests/recommendation-accept-action.test.ts` | Repaired |
| R8 shadow/rollback | `36e7e46`; `tests/recommendation-lifecycle.test.ts`, `tests/board-snapshot.test.ts`, integration tests | Repaired |
| TypeScript | `npx tsc --noEmit` | exit 0 |
| Full suite | `npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'` | 1,037 passed / 20 skipped, exit 0 |
| Isolated database | `DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run tests/customer-recommendations-postgres.integration.test.ts` | 8/8 passed, exit 0 |
| Build | `npm run build` | exit 0, compiled successfully |
| Application database | No migration or write performed | Unchanged |

The green totals prove the repaired engineering paths. They do not prove fresh monthly
discovery, SEO usefulness, browser/accessibility quality or independent expert approval.

## Residual gaps

### G1 — Package 2: inventory is capped at 500 and searched by URL only

**Evidence.** `lib/recommendation/packet.ts:88` defines `MAX_INVENTORY = 500`;
`loadInventory` (`:523–531`) orders by URL ascending and takes 500 rows. The packet
inventory is `rows.slice(0, MAX_INVENTORY)` (`:776`). `inventory_search` in
`lib/recommendation/contracts.ts:1091–1106` matches only URL substrings against that
capped list. A relevant page beyond the first 500 URLs, or a page with an arbitrary URL
such as `/p/123`, is invisible even when its title or body answers the question.

The limitation string at `:612` reports the cap, which is honest, but the analysis cannot
complete the inventory investigation. This fails package 2.1 (“load the complete known
inventory with correct pagination… selection must not silently hide root-level/
arbitrarily named or language-variant answers”).

**Required failing regression.** Seed 501+ `auditPage` rows. Put the answering content
on row 501 with an arbitrary URL and a title/content term absent from the URL. Assert
the packet can find and retrieve it; assert `inventory_search` finds it by title/content,
not only URL. Assert the report distinguishes complete inventory from capped discovery.

**Required fix.** Paginate `loadInventory` (cursor/batches) or build a complete index;
make `inventory_search` search title and body (or a documented hierarchical index) over
the complete known inventory. Keep a bounded packet projection, but do not use the
projection as the search universe. Preserve the “known inventory is not discovery”
limitation.

### G2 — Package 2: no rendered/headless fallback for client-rendered pages

**Evidence.** `lib/recommendation/packet.ts:309` returns `unavailable("page is a bot
challenge or client-rendered shell", ...)` and never tries a rendered read. The repository
already has Chromium discovery and headless screenshot support in
`lib/agent-tasks/screenshots.ts:83–150`, but recommendation retrieval does not use it.

Package 2.2 requires “existing general safe fetch/render capabilities when necessary” and
the package pass criteria include “rendered service/quote pages”. A JS-rendered quote or
service page currently stays unknown even when it is publicly readable in a browser.

**Required failing regression.** Serve a fixture whose initial HTML is a shell and whose
answer appears only after script execution. Assert the current packet records
`unavailable` (failing-before). Then assert the repaired path reads the rendered text,
records retrieval method `rendered`, final URL, status, supplied-text hash, truncation and
shell state, and charges the bounded budget. If Chromium is unavailable, assert a typed
blocked result with attempts, not a claim of absence.

**Required fix.** Add a bounded rendered fallback through the existing safe
fetch/render/screenshot capability. Keep origin/redirect/SSRF/byte/deadline checks. Do
not treat a failed render as proof the page lacks an answer.

### G3 — Package 2: the monthly cycle never bootstraps a tenant with no topics

**Evidence.** `lib/jobs/monthly-cycle.ts:151` skips research when
`topics.length === 0`. `scripts/job-worker.ts:186–194` calls `ensureTenantAnalysis`
only **after** a scheduled research run. A new tenant with no profile, no knowledge and
no topics therefore gets a crawl and a GSC sync, never a research run, and never the
knowledge bootstrap that would derive topics. The monthly path cannot start itself.

This fails package 2.6 (“reuse the existing automatic business-knowledge bootstrap for
missing **or unusable/empty** knowledge on the requested active site”) and the goal’s
“existing automated monthly analysis” requirement.

**Required failing regression.** Seed a new active site with no site profile, no
business-knowledge document and no topics. Run `runMonthlyCycle` (mock the queue). Assert
the current cycle skips research and leaves knowledge missing (failing-before). Then
assert the repaired cycle bootstraps knowledge, derives topics and queues research in the
same or next cycle. A second run must be idempotent and must not double-queue.

**Required fix.** Invoke `ensureTenantAnalysis(db, site.id, { apply: true })` as part of
the monthly cycle before the research-topic decision, or immediately after crawl
completion. It must remain bounded by the existing join/acquisition ceilings and must
report pending work rather than waiting. Do not add a second bootstrap pipeline.

### G4 — Package 2: empty/unusable knowledge is treated as present

**Evidence.** `lib/tenants/analysis.ts:240–244` marks business knowledge `ok` when a
`BusinessKnowledgeDocument` row exists, without checking whether its latest revision has
usable fields. `ensureTenantAnalysis` only bootstraps when the step is `missing` or the
site context is absent (`:353–360`). A document with empty or unusable fields therefore
blocks the bootstrap forever.

Package 2.6 explicitly requires missing **or unusable/empty** knowledge.

**Required failing regression.** Seed a knowledge document whose latest revision has
empty fields. Assert `inspectTenant` currently reports `ok` and `ensureTenantAnalysis`
does not extract (failing-before). Then assert the repaired inspection reports the
document as unusable and the bootstrap runs, while preserving owner facts and accepted
revisions.

### G5 — Package 2: evaluation uses a different bootstrap entry point

**Evidence.** `scripts/evaluate-need-assessment.ts:115` calls
`extractBusinessKnowledgeFromSite(..., { dryRun: true })` directly. The monthly path uses
`ensureTenantAnalysis`, which also handles site context, topics, profile and acquisition.
The script’s comment at `:118` claims “same orchestration as the monthly bootstrap”, but
it is not the same entry point.

Package 2.6 requires production and evaluation to use the same bootstrap orchestration,
not merely the same extraction model with different fetching.

**Required failing regression.** A parity test that exercises the evaluation bootstrap
path and the monthly bootstrap path against the same seeded tenant and asserts the same
extracted fields, page set, language and fact attribution. The evaluation path must stay
read-only (`dryRun`/`apply: false`), but it must call the shared orchestration.

**Required fix.** Extract a shared `bootstrapBusinessKnowledge` helper (or an
`ensureTenantAnalysis` mode) used by both paths. Do not duplicate fetching, page
selection or attribution in the evaluation script.

### G6 — Package 4: browser and accessibility checks were never run

**Evidence.** No browser/accessibility artifact exists for the updated detail panel. The
handoff itself lists it as remaining (`docs/structural-recommendation-handoff-2026-11-04.md:140`).
The package 4 pass criterion requires desktop/mobile checks on isolated seeded data,
including an investigation and a recommendation with multiple benefits/reviews.

**Required work.** Seed isolated data for:
- a canonical investigation (`needs_investigation`, typed owner/expert question);
- an actionable recommendation with multiple benefits, risks and review requirements;
- a changed-premise accepted task with the warning visible.

Run the detail page at desktop and mobile. Check:
- keyboard focus order, visible focus, labels, headings, contrast and ARIA;
- no horizontal overflow, no clipped decision fields, all coverage/excerpts/benefits/
  reviews reachable;
- machine blockage is visually distinct from owner work;
- packet references are real links, not `source:<id>`.

Use the existing Chromium capability plus the already-installed `axe-core` through a
dev-only script; do not add a production dependency. Save screenshots and the axe JSON
under `docs/screenshots/` or `/tmp/opencode/`, and cite the paths in the report. Fix every
material finding and re-run. If a check cannot be automated, record the manual check and
the evidence; do not claim it passed because the page rendered.

### G7 — Package 5: shadow is not a complete all-candidate diff

**Evidence.** `lib/recommendation/shadow.ts:122` caps assessments at
`Math.max(0, Math.min(opts.maxAssessments ?? 8, 12))`. Rows beyond the cap are labelled
`failed` with `"shadow assessment budget exhausted"` (`:250–251`). The CLI clamps the
same way (`scripts/shadow-recommendations.ts:34`). A report with 20 candidates therefore
claims 12 failures and hides 8 unassessed candidates. Package 5.2 requires “compare all
candidates, not top cards” and a complete proposed diff.

**Required failing regression.** Seed 15 candidates with `maxAssessments: 8`. Assert the
current report has 8 assessed and 7 `failed` (failing-before). Then assert the repaired
report has 8 assessed, 7 `not_assessed`, `complete: false`, and a reason that is budget,
not failure. With `maxAssessments: "all"` (or an explicit all mode), assert 15 assessed
and `complete: true`.

**Required fix.**
- Add a distinct `not_assessed` status; never label budget exhaustion `failed`.
- Add `complete`, `candidateCount`, `assessedCount`, `notAssessedCount`, `budget` and
  `reason` to the report.
- Support an explicit all-candidate mode with the shared ledger; the CLI must expose it.
- Keep the default cap for cost, but make incompleteness explicit.

Also include preserved task identity, not only `preservedHumanWork: boolean`: the task
id, status, decision id/version and whether its snapshot differs. Package 5.2 requires
“preserved tasks”, and a reviewer cannot currently see which task is preserved.

### G8 — Package 5: no output/input destination validation for shadow

**Evidence.** `lib/recommendation/shadow.ts:353` writes any `opts.outPath` with
`writeFileSync`. `scripts/shadow-recommendations.ts:23` defaults to `/tmp/opencode` but
accepts any `--out`; the script imports the application `db` directly and has no database
destination check. Package 5.3 requires input/output destination validation before
connection/write, with tests rejecting application/ambiguous destructive-test
destinations.

**Required failing regression.** Assert the current CLI/lib accepts:
- an output path inside the repository (for example `./shadow.json`);
- an output path that is an existing board snapshot;
- the application `DATABASE_URL` without a disposable schema.

Then assert the repaired path refuses each before any model call or write, and accepts an
absolute `/tmp/opencode/...` path plus a `schema=csv_validation` URL.

**Required fix.** Add a pure `assertShadowDestination({ outPath, databaseUrl })`:
- refuse relative paths, repository paths, directories, symlinks and non-`.json` paths;
- require an absolute path under an explicit allowed root;
- require a disposable/read-only database URL and refuse the application URL or a URL
  without an explicit schema;
- fail before assessment, not after the model has spent budget.
Test the validator directly and through the CLI.

### G9 — Package 5: rollback is not scoped to the authorised project/run

**Evidence.** `lib/ops/board-snapshot.ts:72` snapshots every active site;
`restoreBoardSnapshot` loops every site in the snapshot (`:141`). There is no
`projectId`, `siteId` or `runId` parameter. Package 5.4 requires restoration scoped to
the authorised run/project, and package 5.3 requires destination validation. A restore
of one project’s snapshot currently rewinds every project in the file.

**Required failing regression.** Snapshot two projects. Modify both. Restore with
`{ projectId: "p1" }`. Assert the current call restores both (failing-before). Then assert
only `p1` is restored, `p2` is reported out of scope and unchanged, and an unscoped call
is refused unless `{ all: true }` is explicit.

**Required fix.** Record the scope/run id in the snapshot. Add scope options to
`takeBoardSnapshot` and `restoreBoardSnapshot`. Default to refusing an unscoped restore.
Keep the transaction, CAS and evidence-selection guards.

### G10 — Package 5: no shadow→apply equivalence test

**Evidence.** The integration suite covers rollback and evidence selection, but no test
runs shadow decisions and then applies the same decisions and compares the entire
published state. Package 5’s pass criterion requires exactly that: “real isolated tests
run model-controlled shadow decisions and verify entire published state equality; apply
projects those same semantic results.”

**Required work.** On a disposable schema:
1. Seed a tenant, findings, an accepted task and an existing opportunity.
2. Run `shadowRecommendations` with an injected deterministic assessor.
3. Assert the shadow wrote nothing (row counts, decisions, evidence selection unchanged).
4. Apply the shadow’s proposed decisions through `publishDecision`.
5. Compare every published opportunity field to `proposedProjection` (except ids and
   timestamps), assert accepted work is preserved and the task snapshot is unchanged.
6. Assert a second apply is idempotent.

This is an engineering equivalence test, not proof of SEO usefulness.

## Package 6 status

Package 6 has two tracks and both remain open:

- **Track A — historical regression assessment.** Real read-only results exist for Susi,
  Atelier, Casamigo and Oceanic, but they are not packaged as a reproducible evaluation
  manifest with saved attempts, packets, decisions, failures and a reviewer packet. The
  manifest must name sites, model, destinations, maximum requests/rounds and spend.
- **Track B — fresh monthly discovery.** The held-out Astrid tenant proves extraction
  only. It has no research run or source observations, so fresh discovery is blocked on
  authorised research acquisition. Do not replace it with `--finding`, `--need` or a
  handcrafted candidate.
- **Independent review.** A qualified SEO/business reviewer has not reviewed the exact
  packets, traces, outcomes and proposed diff. A second AI is not independent approval.

The coding AI can build the harness, manifest schema and artifact layout now. It must
stop before any live model/provider call or paid acquisition until the owner approves the
manifest.

## Package 7 status

`docs/structural-recommendation-handoff-2026-11-04.md` is stale and misleading:

- reports `982 passed / 16 skipped` instead of the current `1,037 / 20`;
- predates `36e7e46` and describes the old rollback/evidence behaviour;
- lists package 5 as “implemented and unit/integration tested” without the residuals;
- does not link the R7/R8 repair or the safety repair;
- has no corrected completion audit, exit codes, skip reasons or rollout runbook.

It needs a correction notice now and a full rewrite in package 7. Preserve it as history;
do not delete it.

## Do not reopen without new evidence

The following are repaired and should not be re-litigated absent a new failing case:

- safety findings 1–7 and fairness (`dfefa00`, `828ed5c`);
- R7 investigation acceptance, stale-render refusal, tenant scope, transactional
  acceptance, duplicate-click refusal and changed-premise display (`36e7e46`);
- R8 shared projection, full-decision comparison, accepted-work preservation,
  transactional rollback, CAS and evidence-selection restoration (`36e7e46`).

New work should not weaken those tests, raise budgets, add tenant patches, introduce a
positive-output quota or replace real evaluation with injected-model happy paths.

---

# Copy-ready assignment for the coding AI

## Assignment: close the migration residuals, then finish the evaluation harness and handoff

You are working in `/SEO` at `36e7e46`. Read, in order:

1. `CLAUDE.md`, `AGENTS.md`, `docs/agent-coordination.md`.
2. The canonical plan
   `1793822430905-finish-the-seo-analysis-not-just-the-recommendation-plumbing.md`
   (packages 2, 4, 5, 6, 7).
3. This review.
4. `docs/recommendation-lifecycle-shadow-repair.md`,
   `docs/recommendation-analysis-safety-252df72-repair.md`,
   `docs/recommendation-analysis-review-252df72.md`.
5. The actual code and tests before trusting any report.

### Constraints

- No live model/provider calls, paid acquisition, application-database migration or
  write, publication, merge or deployment without separate written approval.
- Use the disposable `csv_validation` schema for database tests. Do not point tests at
  the application database.
- Preserve the safety/R7/R8 repairs. Do not weaken assertions, delete scenarios, raise
  budgets, add tenant exceptions or force a readiness to get green.
- Do not build a second pipeline, recommendation table or bootstrap system. Reuse
  `lib/recommendation/*`, `lib/tenants/analysis.ts`, `lib/jobs/monthly-cycle.ts`,
  `lib/ops/board-snapshot.ts` and the existing Chromium capability.
- Claim only what the evidence shows. Engineering correctness, real SEO usefulness,
  independent review and production rollout are four separate claims.

### Phase 1 — write the failing regressions first

Add tests that fail on the current code for G1–G10. Keep the failing output in the
report. Minimum cases:

1. **Inventory pagination/search:** 501+ pages; answer on page 501 with an arbitrary URL;
   `inventory_search` by title/content; complete-vs-capped reporting.
2. **Rendered fallback:** shell HTML, answer only after script execution; typed blocked
   result when rendering is unavailable.
3. **Monthly bootstrap:** new tenant with no profile/knowledge/topics; first cycle
   bootstraps and queues research; second cycle is idempotent.
4. **Empty knowledge:** document with empty fields is unusable and triggers bootstrap.
5. **Evaluation parity:** evaluation and monthly bootstrap produce the same fields/pages/
   language/attribution for the same tenant.
6. **Shadow completeness:** 15 candidates, cap 8 → 7 `not_assessed`, `complete: false`;
   all mode → 15 assessed, `complete: true`; preserved task identity present.
7. **Destination validation:** refuse repo-relative output, existing snapshot output,
   application DB URL and schema-less URL; accept `/tmp/opencode/...` + disposable schema.
8. **Rollback scope:** two projects; restore one; the other unchanged; unscoped refused.
9. **Shadow→apply equivalence:** shadow writes nothing; apply projects the same semantic
   results; accepted task snapshot unchanged; second apply idempotent.

For each, record the exact command, the assertion and the actual failing output.

### Phase 2 — close package 2 residuals (G1–G5)

Implement, in this order:

1. Complete inventory pagination/search, with a bounded packet projection but a complete
   search universe. Do not silently hide arbitrary/root-level/language-variant pages.
2. Bounded rendered fallback through the existing safe fetch/render capability. Record
   method, final URL, status, hash, truncation and shell state. A failed render is
   unknown, not absence.
3. Monthly-cycle bootstrap: call `ensureTenantAnalysis` before the research-topic
   decision (or immediately after crawl), with existing ceilings and idempotence.
4. Treat empty/unusable knowledge as missing in `inspectTenant`/`ensureTenantAnalysis`,
   preserving owner facts and accepted revisions.
5. Share one bootstrap orchestration between production and evaluation; keep evaluation
   read-only.

Run the targeted tests after each change. Do not proceed to package 5 while a package 2
regression is red.

### Phase 3 — close package 4/5 residuals (G6–G10)

1. Browser/accessibility review on isolated seeded data. Use Chromium + `axe-core`;
   desktop and mobile; investigation, multiple benefits/reviews and changed premise.
   Save screenshots and axe JSON; fix material findings; cite artifact paths.
2. Complete shadow diff: `not_assessed` status, completeness fields, all-candidate mode,
   preserved task identity.
3. Shadow destination validation before any model call or write; tests for refusal and
   acceptance.
4. Scoped snapshot/restore with explicit `projectId`/`siteId`/`runId`; refuse unscoped
   restore unless `all: true`.
5. Shadow→apply equivalence integration test on the disposable schema.

### Phase 4 — package 6 harness (no live calls yet)

Build:

- a manifest schema/file naming sites, model, destinations, max requests, max rounds,
  spend ceiling, output paths and approval reference;
- a runner that saves **every** attempt, packet, decision, failure and selected case, not
  only the final success;
- Track A packaging for the historical Susi/Atelier/Casamigo/Oceanic cases;
- Track B packaging for the held-out tenant, with an explicit `blocked` outcome when no
  authorised research sources exist;
- a reviewer packet containing the exact final packets, retrieval trace, outcomes and
  proposed diff.

Run only offline/injected mechanics tests. Stop before the first live model/provider
call and request approval of the manifest. Do not fabricate fresh discovery from
`--finding`, `--need` or a handcrafted candidate.

### Phase 5 — package 7 corrected handoff

Rewrite `docs/structural-recommendation-handoff-2026-11-04.md` (or add a clearly linked
successor) with:

- release identity: commits, branch, migration status, no production writes;
- corrected command results with exit codes, counts, skips and environments;
- per-package acceptance evidence, including the residuals above;
- the original 13 defects and their dispositions;
- the call-site retirement map and what remains unmigrated (O1–O12);
- schema/API/backward-compatibility and migration results;
- privacy/cost receipts;
- independent SEO review status and disagreements;
- exact separately authorised rollout/rollback runbook;
- a conspicuous correction notice on the old handoff and older reports.

Tick a package in the canonical plan only when its own exit checks pass. Do not tick
packages 1–5 because this review exists.

### Verification commands

Run and report the exact exit codes:

```bash
npx tsc --noEmit
npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'
set -a && source .env.local && set +a
BASE="${DATABASE_URL%%\?*}"
DATABASE_URL="${BASE}?schema=csv_validation" RUN_CUSTOMER_REC_DB_TESTS=1 \
  npx vitest run tests/customer-recommendations-postgres.integration.test.ts
npm run build
npx eslint <changed files>
```

Add targeted commands for the new tests, the browser/accessibility script and the shadow
CLI. Save full logs under `/tmp/opencode/` and cite them.

### Report format

For each gap, report:

```
G1 inventory pagination
- Failing before: <command>, <assertion>, <actual output>
- Fix: <files and behaviour>
- Passing after: <command>, exit code, counts
- Artifact: <path>
- Skips/limits: <exact reason>
```

End with:

- what is verified;
- what is implemented but unverified;
- what remains gated (live evaluation, authorised research acquisition, independent
  review, production migration, publication, merge, deployment);
- the next approval you need.

Do not present deterministic tests as SEO usefulness. Do not present a green suite as
migration completion.
