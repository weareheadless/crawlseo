# Structural recommendation handoff — corrected 2026-11-04

> This replaces the stale 2026-11-04 draft. The earlier text is preserved in git
> history. It reported `982 passed / 16 skipped`, predated the safety/R7/R8 repairs
> and described the old rollback behaviour. Do not use it as acceptance evidence.

## Release identity

- Branch: `main`, local commits only. **Not pushed, merged or deployed.**
- Head commit: `4f1f70b` (residual repair), on top of `36e7e46` (R7/R8),
  `828ed5c` and `dfefa00` (safety).
- Migration: `20261104180000_opportunity_recommendation_decision` (additive).
- Applied to: disposable `csv_validation` only. **Not applied to the application
  database.**
- Production publication/deployment: **none**.
- Live model/provider calls: **none** in this pass.
- Real evaluation: read-only historical runs only; the fresh monthly evaluation is
  gated by an approved manifest.

## What this pass repaired

The safety review is closed by `dfefa00`/`828ed5c`; R7 lifecycle/acceptance and R8
shadow/rollback are closed by `36e7e46`. This pass closes the ten residuals in
`docs/recommendation-migration-completion-review-2026-11-04.md`:

| Gap | Repair |
|---|---|
| G1 inventory | Reads every crawl page in cursor batches; searches URL, title and body; bounded model projection is explicit |
| G2 rendered pages | Bounded Chromium render for shells; records method/status/hash/truncation; failure stays unknown |
| G3 monthly bootstrap | Knowledge/language/topics bootstrap before the research stage; derived topics used in the same cycle |
| G4 empty knowledge | Empty/unusable revisions are treated as missing and trigger the bootstrap |
| G5 evaluation parity | Evaluation calls `ensureTenantAnalysis` in dry-run mode |
| G6 browser/accessibility | Seeded desktop/mobile check with axe-core; shell labels and source-link underline fixed |
| G7 complete shadow | `not_assessed` distinct from `failed`; completeness/budget fields; all mode; preserved task identity |
| G8 shadow destinations | Output path and disposable database URL validated before any work; CLI opens the validated URL |
| G9 scoped rollback | Snapshots/restores carry project/site/run scope; out-of-scope sites are skipped |
| G10 shadow/apply | Projection computes the same score inputs and evidence completeness that publish stores; equivalence test |

Full detail: `docs/recommendation-migration-residual-repair-2026-11-04.md`.

## Verification

Commands and results from the current tree:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'` | 1,058 passed / 21 skipped, exit 0 |
| `DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run tests/customer-recommendations-postgres.integration.test.ts` | 9 passed, exit 0 |
| `npm run build` | exit 0, compiled successfully |
| `npx tsx scripts/browser-review.ts --database-url=... --out-dir=/tmp/opencode/browser-review-3` | exit 0, zero axe violations, no horizontal overflow |

Browser artifacts: `/tmp/opencode/browser-review-3/report.json` plus
`investigation-desktop.png`, `investigation-mobile.png`,
`actionable-desktop.png`, `actionable-mobile.png`.

The full suite initially OOM'd because a legacy fixture ignored the new inventory
cursor. `loadInventory` now stops on a missing or repeated cursor; the targeted
test and the full suite then passed. No assertion was weakened.

## Package status

| Package | Status | Evidence |
|---|---|---|
| 1 — contract and failures | Accepted | `docs/recommendation-analysis-safety-252df72-repair.md`, offline probes |
| 2 — evidence retrieval | Accepted | G1–G5 tests; inventory, rendered, monthly bootstrap, empty knowledge, evaluation parity |
| 3 — semantic integrity | Accepted | Safety repair tests; exact packet/decision round trips |
| 4 — lifecycle and UI | Accepted | R7 tests; seeded browser/accessibility check |
| 5 — shadow and rollback | Accepted | R8 tests; complete shadow diff, destination validation, scoped rollback, shadow/apply equivalence |
| 6 — fresh evaluation | Open, gated | Manifest/plan gate in `lib/recommendation/evaluation-manifest.ts`; live calls need owner approval |
| 7 — reviewed handoff | This document | Independent review and rollout approval still pending |

“Accepted” here means the engineering exit checks for that package pass. It does
not mean the SEO output is useful or independently approved.

## Original 13 defects

The dispositions are recorded in `docs/recommendation-analysis-safety-252df72-repair.md`
and the review. The categories are:

1. unread-page negative coverage;
2. semantic enum/alias coercion;
3. guessed target roles;
4. duplicate/conflicting coverage selection;
5. fixed-prefix extraction hiding later sections;
6. homepage-first fetch starvation;
7. client-rendered content treated as absent;
8. prompt/model invalidation;
9. later candidates starved by cached first items;
10. old-evidence rejection not reconciled;
11. stale acceptance race;
12. hidden structured investigation;
13. budget/replay/archival fidelity.

## Call-site map and unmigrated work

Migrated entry points: new research, reassessment, shadow, publish, acceptance,
evaluation and the monthly tenant bootstrap. They share the canonical packet,
decision, validation and projection code.

Unmigrated: the legacy O1–O12 detectors, their lexical verdicts and their scores.
They remain readable and explicitly labelled unmigrated; they cannot qualify
migrated work. No claim is made that the whole product is AI-qualified.

## Schema, API and compatibility

- Packet/decision contracts are versioned (`evidence-packet/2`,
  `recommendation-decision/2`). The `rendered` retrieval value and
  `not_assessed` shadow status are additive.
- `recommendationDecision`, version, fingerprint and evidence id are nullable
  legacy-compatible columns. Legacy rows are never presented as freshly validated.
- The migration is additive and was exercised only on the disposable schema.
- No API shape was removed. Shadow reports add fields; existing readers ignore them.

## Privacy and cost

- No live provider spend. Shadow writes one JSON artifact and reads the explicitly
  supplied disposable database.
- Browser review seeds and deletes an isolated workspace; it never points at the
  application schema.
- Evaluation manifest limits are mandatory: candidates, requests, rounds and spend.
- Full logs are under `/tmp/opencode/`; no credential was printed.

## Package 6 — evaluation status

Track A (historical regression assessment) has real read-only results for Susi,
Atelier, Casamigo and Oceanic, but the exact packets, attempts, failures and
proposed diff are not yet packaged as one reviewer artifact.

Track B (fresh monthly discovery) remains blocked for the held-out tenant: its
extraction succeeds, but it has no authorised research run/source observations.
Do not substitute `--finding`, `--need` or a handcrafted candidate.

The manifest/plan gate exists. To run a live evaluation:

1. write a manifest naming sites, model, output directory, request/round/spend
   limits and an owner approval reference;
2. run the planner without `--execute`;
3. obtain the owner's matching approval;
4. run with `--execute --approval=<reference>` and save every attempt, packet,
   decision and failure.

A qualified SEO/business reviewer must then judge the exact packets and outcomes.
A second AI is not independent approval.

## Package 7 — rollout and rollback runbook (not authorised)

Stop until the owner authorises each step separately.

1. **Preflight:** confirm the target commit, migration, backup and maintenance
   window; run the full suite, build and browser check on the release candidate.
2. **Migration:** apply the additive migration to a copy of the application
   database; verify schema and legacy reads.
3. **Snapshot:** take a scoped board snapshot for the target project/site and
   record the snapshot path, checksum and run id.
4. **Shadow:** run the shadow against the same scoped data; review every
   added/changed/removed/not-assessed/failed entry and preserved task.
5. **Apply:** publish the reviewed decisions for the scoped project only; verify
   opportunities, accepted task snapshots and evidence selection.
6. **Rollback:** restore the same scope with `restoreBoardSnapshot(db, path,
   { projectId, siteId, runId })`; confirm conflicts are reported, out-of-scope
   sites are skipped and no accepted task was rewritten.
7. **Stop conditions:** any checksum mismatch, destination mismatch, unexpected
   accepted-work change, unassessed candidate or failed validation stops the run.

Production migration, content-populating crawl, shadow/apply reassessment,
publication, merge and deployment remain unauthorised.

## Remaining gates

- package 6 Track A reviewer artifact;
- package 6 Track B authorised research acquisition and fresh run;
- independent SEO/business review;
- production migration, apply and deployment approval;
- latest-diff manager review.

No green engineering total is evidence of SEO usefulness, independent approval or
production readiness.
