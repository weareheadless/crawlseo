# Structural recommendation handoff — 2026-11-04

## Release identity

- Commits: `4d4092c` (canonical packet/decision/projection), `e42e185`
  (reassessment, task gate, snapshot/rollback), plus the preceding review docs.
- Migration: `20261104180000_opportunity_recommendation_decision` (additive).
- Applied to: disposable `csv_validation` only. **Not applied to the application
  database.**
- Production publication/deployment: **none**.
- Real evaluation: read-only, no provider spend, no opportunity/task/knowledge write.

## Failure-to-fix map (the 13 reproduced defects)

| # | Defect | Fix | Evidence |
|---|---|---|---|
| 1 | Investigation promoted to implementation | AI chooses readiness/intervention; validator rejects a change on investigate; task gate refuses non-actionable decisions | `tests/recommendation-contract.test.ts`, `tests/funnel-task-gate.test.ts` |
| 2 | Blocked target differs from assessed gap | target must be a supplied page; `update_page` target needs `partially_answers`/`does_not_answer` | contract test |
| 3 | Website citation invents customer demand | need basis roles: observed bases require `source:`; search requires `search:`; offer fit requires `fact:` | contract test, real Susi run |
| 4 | Forum citation rejects site premise without a checked answer | contradicted premise requires an assessed page with a verbatim excerpt | contract test |
| 5 | Empty coverage creates an asset | `create_asset` requires an assessed non-answer and forbids adequate/unassessable coverage | contract test |
| 6 | Quote outside supplied model text passes | packet seals the post-truncation text; excerpts validate against it | contract test, packet tests |
| 7 | Zero extracted content marked complete | packet limitations, unavailable pages, no optimistic completeness flag | packet builder, real Atelier run |
| 8 | Risk/uncertainty/benefit lost | complete decision persisted in `Opportunity.recommendationDecision` and task plan; detail renders reviews/uncertainty | integration test, UI tests |
| 9 | Spanish high-risk topic has no review | review requirements are model-authored and preserved; real Oceanic run carries safety/legal review | real run, contract test |
| 10 | Failures bypass call limit | bridge counts attempts including failures; reassessment bounds attempts | `tests/research-finding-evidence.test.ts` |
| 11 | Obsolete assessment reused by sentence | reuse keyed to sealed packet hash + policy/prompt/model | `tests/research-finding-evidence.test.ts`, reassessment dry run |
| 12 | Lexical partial match rejects a semantic gap | lexical claim checks are diagnostic; synthesizer no longer drops the finding | `lib/research/synthesizer.ts`, real Atelier corpus run |
| 13 | All-rejected run leaves old work visible | rejected/no-action parks linked detected rows by dedup key and evidence edge; suppression runs in detectors | contract test, real rejected runs |

## Removed or bypassed competing rules

- `lib/funnel/assess-need.ts` and `lib/research/need-assessment.ts` deleted.
- `decideRecommendation`/`assertDecision` removed from `lib/funnel/decision.ts`; the
  module now supplies shared labels/types only.
- O13/O14 detectors project the canonical decision; legacy findings are explicit
  unassessed backlog.
- The lexical claim verdict no longer removes findings before assessment.
- Score bands, completeness legs and knowledge presence cannot set readiness or
  publish a canonical decision. Hysteresis and the open cap skip decision-backed
  rows.
- The evaluation CLI uses the production packet builder/assessor/validator, not its
  own retrieval or ranking.

## What remains legacy

O1–O12 and the technical detectors still use their existing observation and scoring
paths. They are not claimed to be migrated to the canonical decision contract. O10/
O11 generic labels are not allowed to override a migrated O13/O14 decision; the
remaining legacy types need their own reviewed cutover.

## Verification

```
npx tsc --noEmit                                   # clean
npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'
# 970 passed, 16 skipped
DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run \
  tests/customer-recommendations-postgres.integration.test.ts
# 4 passed
npm run build                                      # compiled successfully
```

Integration tests now include: assessment → persisted decision → opportunity;
legacy contradiction → no work; dry-run shadow equality; rollback preserving a
newer human decision and parking rows created after the snapshot; checksum refusal;
and a hard guard that refuses destructive tests outside `schema=csv_validation`.

## Real read-only outputs

| Site | Decision |
|---|---|
| Oceanic — beginner lanyard/depth safety | actionable update to the existing land-practice article; safety + legal review |
| Susi — foreign ownership/fideicomiso | needs investigation: premise contradicted, but a more relevant page is unassessable |
| Atelier — off-topic corpus | rejected: research failure, not customer work |
| Atelier — lampshade service page | needs investigation: existing page text unavailable |
| Casamigo — Mexico City | rejected: outside stated service area; one portal listing is not demand |
| Unseen Astrid tenant | automatic extraction + inferred pricing need → needs investigation |

The full packet, retrieved text, decision, validation result and raw output are
written by `scripts/evaluate-need-assessment.ts` to `/tmp/opencode/structural-*.json`.

## Rollout runbook (requires separate approval)

1. **Preflight**: record code commit, migration state, current published board
   checksum and data versions. Take a board snapshot including decisions.
2. **Isolated validation**: run the guarded integration suite on a disposable schema;
   run `scripts/reanalyse-all.ts --dry-run` and review the decision diff.
3. **Content population**: run the crawl that stores rendered `contentText`; verify
   page text exists for the active tenants.
4. **Migration**: apply the additive migration through the normal reviewed release
   path. Do not use a per-tenant script.
5. **Shadow**: run reassessment in dry-run mode for every active canonical tenant;
   review added/changed/removed/maintained/rejected/failed outcomes and the preserved
   accepted tasks.
6. **Publication**: with explicit approval, apply the reassessment for the reviewed
   tenant set. Verify the board, detail page, task plan and review requirements.
7. **Rollback**: if the published state is wrong, restore the preflight snapshot.
   Restore is compare-and-swap, preserves newer human decisions, and parks rows
   created after the snapshot.
8. **Post-check**: compare customer-facing pages, record exact code/data versions,
   and obtain business/SEO sign-off. HTTP health is not SEO acceptance.

## Open approvals

- Independent SEO/business review of the real outputs.
- Production migration and content-populating crawl.
- Shadow/apply reassessment for active tenants.
- Deployment and customer-facing publication.
- Browser/accessibility review of the updated detail panel.

No approval is implied by this document or by the green test totals.
