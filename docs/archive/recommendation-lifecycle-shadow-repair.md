# R7 lifecycle and R8 shadow/rollback repair

## Scope

This patch closes the two release blockers named by
`docs/recommendation-analysis-review-252df72.md` and described in
`docs/recommendation-analysis-review-06b1772.md`:

- **R7** — investigation acceptance and stale-page protection.
- **R8** — publication-equivalent shadow and atomic rollback/selection restoration.

No live model/provider calls, application-database migration, publication, merge
or deployment were performed.

## R7 — investigation acceptance and stale-page protection

### Acceptance gate

`lib/funnel/join.ts`, `lib/funnel/accept.ts`,
`app/(dashboard)/sites/[siteId]/opportunities/actions.ts`,
`components/funnel/decision-bar.tsx`

- The old pre-parse check that rejected every non-actionable supplied decision was
  removed. Migrated recommendations now accept a canonical
  `needs_investigation` decision as investigation work, with the task plan marked
  `kind: "investigation"`.
- Acceptance requires the decision version rendered to the person
  (`expectedDecisionId`). A missing or stale version is refused before any task is
  created.
- Acceptance requires the site's project scope (`expectedProjectId`), and the
  action boundary (`acceptOpportunityForSite`) verifies that the opportunity
  belongs to that project. A cross-project opportunity is refused.
- The task and opportunity transition require a transaction-capable client. The
  previous non-atomic fallback is gone.
- Duplicate clicks are refused because the first acceptance moves the opportunity
  out of the acceptable statuses.
- The task plan keeps its immutable decision snapshot. If a later assessment is
  rejected or no-action, `publishDecision` now records the new decision on an
  accepted/in-progress opportunity without changing its status or rewriting the
  task. The detail page's existing `decisionChanged` warning becomes truthful.

### Tests

`tests/recommendation-lifecycle.test.ts`, `tests/recommendation-accept-action.test.ts`

- Canonical investigation acceptance.
- Stale render-time decision refusal.
- Tenant/project mismatch refusal.
- Duplicate-click refusal.
- Transaction failure leaves the opportunity detected and creates no task.
- Accepted work keeps its status while its decision is updated to the new rejected
  assessment.
- The server action forwards the render-time decision version and site scope to
  the acceptance boundary.

## R8 — publication-equivalent shadow and atomic rollback

### Shared projection

`lib/recommendation/projection.ts`

One pure module now owns:

- opportunity type, title, summary, dedup identity and score inputs;
- the recommendation fingerprint and full decision projection;
- the fallback dedup identity used by reassessment and shadow;
- full decision-content comparison (identity and assessment time excluded,
  packet/policy/prompt/model/limitations/coverage/reviews included).

`publishDecision` and `shadowRecommendations` both use this module, so a shadow
report describes the same row an apply would write.

### Shadow report

`lib/recommendation/shadow.ts`

- Compares full decisions, not four summary fields. A new legal-review
  requirement now reports `changed`.
- Includes the full current/proposed decisions and the exact archived/proposed
  packets.
- Includes the current and proposed opportunity projections, current opportunity
  status and whether accepted human work is preserved.
- A rejected proposal against accepted/in-progress work is shown as `changed`
  with `preservedHumanWork: true`, not hidden as `removed`.
- Uses the shared fallback dedup identity instead of inventing another one.

### Rollback

`lib/ops/board-snapshot.ts`

- The entire restore runs in one transaction; a non-transactional client is
  refused.
- Opportunity writes use `updatedAt` compare-and-swap. A concurrent edit is
  reported, not overwritten.
- Evidence writes use `updatedAt` compare-and-swap.
- Snapshot evidence rows now capture `createdAt` and `updatedAt`. Post-snapshot
  detection uses creation time, so backfilled `observedAt` cannot masquerade as
  snapshot history.
- Restoring an active evidence row also deactivates its post-snapshot replacement,
  so two generations cannot both remain active.
- Evidence used by preserved newer accepted/in-progress work is left active; the
  superseded snapshot row stays superseded rather than being rewound under it.
- New-row parking is reported only when the parking update actually matched a row.

### Tests

`tests/recommendation-lifecycle.test.ts`, `tests/board-snapshot.test.ts`,
`tests/customer-recommendations-postgres.integration.test.ts`

- Full-decision shadow change (legal review) with full packets and projections.
- Accepted work preserved and reported as changed.
- Concurrent opportunity change reported, not counted as restored.
- New-row parking reported only after a matching update.
- Transaction failure propagates.
- Real-database evidence selection restoration (the old generation becomes
  active, the post-snapshot replacement becomes inactive).
- Real-database preservation of evidence used by newer accepted work.

## Verification

```
npx tsc --noEmit                                      # exit 0
npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'
# 1,037 passed, 20 skipped
DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 \
  npx vitest run tests/customer-recommendations-postgres.integration.test.ts
# 8 passed
npm run build                                         # exit 0, compiled successfully
```

The first build attempt hit a transient Next.js Google-font cache error; an
immediate retry compiled successfully. No source change was made for it.

## Remaining

Independent SEO/business review, held-out fresh monthly discovery, full all-tenant
shadow diff, browser/accessibility validation and production rollout remain
pending. R7 and R8 are no longer release blockers. No approval for a live
evaluation, application-database migration, publication, merge or deployment is
implied by this patch.
