# Structural recommendation handoff — 2026-11-04

## Release identity

- Branch: `main`, local commits only. **Not pushed, merged or deployed.**
- Migration: `20261104180000_opportunity_recommendation_decision` (additive).
- Applied to: disposable `csv_validation` only. **Not applied to the application database.**
- Production publication/deployment: **none**.
- Real evaluation: read-only (`persist: false`, extraction dry run, no provider spend, no
  opportunity/task/knowledge write).

## Corrective implementation (this pass)

The review at `docs/structural-recommendation-review-2026-11-04.md` found the earlier
implementation was a one-shot reviewer with predetermined retrieval. This pass adds the
missing analysis loop and removes the remaining semantic overrides.

### One bounded analysis loop

`candidate → packet → AI decides or requests evidence → scoped retrieval → new packet →
final decision → validation → persistence`

- `lib/recommendation/contracts.ts` defines a discriminated model result:
  `request_evidence`, `final_decision` or failure. Requests carry the unresolved question
  and why it could change the decision; they are not customer recommendations.
- `lib/recommendation/ledger.ts` charges every model call, repair, evidence round,
  retrieval and live fetch before dispatch. Limits are execution policy, not SEO truth.
- `lib/recommendation/run.ts` runs the loop, validates requests against site scope and
  known identities, expands the packet, and refuses to publish an invalid decision.
- `lib/recommendation/packet.ts` supplies requested pages **whole** (up to 20k chars),
  fixes section offsets with an index map, strips builder-site comment/template payloads
  before text extraction, and records retrieval method/failure per page.

### Retrieval repairs

- Inventory pagination is consistent (500 known pages), not a hidden 200-row slice.
- Selection is relevance-first; the homepage no longer consumes the page budget.
- Initial live fetches are limited to two, leaving budget for model requests.
- Wix-style base64/comment payloads are removed via `documentMarkup` before text
  extraction; full HTML is read, then text is capped.
- A requested page is supplied whole, so the model stops re-requesting truncated text.
- Journey requests may inspect a known inventory URL and record observed anchors.
- Per-fact attribution: a business fact is attributed only to a page containing its
  value; otherwise its source is absent, not the first page.

### Semantic overrides removed

- No readiness/coverage/target-role synonym coercion. Only case/hyphen transport
  normalisation is allowed; ambiguous values are validation errors and a bounded repair.
- Duplicate coverage is rejected, not silently merged in favour of an answering row.
- A `does_not_answer` claim requires inspected text; an unread page is unassessable.
- An investigation that asks a person to inspect already-supplied content is rejected.
- `create_asset` alongside an answering page requires an explicit `assetJustification`
  (distinct intent and why the existing answer is insufficient).
- The legacy lexical verdict no longer suppresses O13/O14 assessment; contradicted
  legacy rows remain visible as unassessed backlog. The diagnostic pass cannot mark
  coverage complete with zero readable pages.

### Lifecycle, acceptance and presentation

- Reuse compares the sealed packet hash with the **current** model, prompt, policy and
  schema versions. A changed dependency invalidates the old decision.
- Reassessment checks reuse before consuming the budget and processes oldest-first, so
  cached rows cannot starve later stale rows. New findings and reassessment share one
  ledger per run.
- Rejection reconciliation searches evidence edges from both the superseded and new
  evidence IDs, so a legacy row with a changed dedup key can still be parked.
- Task acceptance loads the authoritative decision from the opportunity, requires a
  migrated O13/O14 row to be `actionable` or a bounded `needs_investigation`, refuses
  legacy-unassessed rows, checks the decision ID supplied by the page, and writes the
  task plus opportunity transition in one transaction with a fingerprint precondition.
- The task plan carries the full decision; investigations get `kind: "investigation"`.
- Detail/API render every coverage assessment, excerpts, premise, investigation, all
  benefits, risks, contradictions and resolved packet references (real URLs, not
  `source:<id>` as an href).

### Shadow and rollback

- `lib/recommendation/shadow.ts` runs the real packet/model/validation loop with
  `persist: false` and writes a proposed diff (added/changed/removed/unchanged/failed)
  to an explicit artifact. It is not a hash-only dry run.
- Board snapshots now include research evidence selection. Restore rewinds active/
  superseded evidence observed before the snapshot, leaves newer evidence untouched,
  parks rows created after the snapshot, and uses compare-and-swap on `updatedAt`.

## Real read-only results (final code)

| Site | Finding | Decision |
|---|---|---|
| Susi | Foreign land ownership / fideicomiso | **no_action** — requested the dedicated fideicomiso and foreign-buyer pages, read them, contradicted the absence premise, found no inadequacy |
| Susi (fresh synthesis) | Foreign-buyer legal mechanics | **no_action** — existing article answers the question thoroughly |
| Susi (fresh synthesis) | Tulum downturn / buyer risk | **no_action** — three supplied Tulum articles already answer it; listing pages surface them |
| Atelier | Off-topic corpus | **rejected** — research failure, not customer work |
| Atelier | Lampshade service page | **actionable / update_page** — targeted section on the readable article; unread category pages acknowledged; no duplicate asset |
| Casamigo | Mexico City | **rejected** — outside the stated service area; one portal listing is not demand |
| Oceanic | Beginner depth safety / lanyard | **actionable / update_page** — specific section on the existing article, subject-matter review retained |
| Astrid (held out) | Fresh monthly discovery | **blocked** — automatic extraction succeeds (9 fields), but no research run/source observations exist, so fresh candidate discovery awaits authorised research collection. This is an acquisition gap, not a manufactured recommendation. |

Artifacts: `/tmp/opencode/v2-susi.json`, `v2-susi-fresh.json`,
`v2-atelier-corpus.json`, `v2-atelier-abatjour.json`, `v2-casamigo.json`,
`v2-oceanic.json`, `v2-unseen-fresh.json`.

The key behavioural change: Susi previously returned an investigation asking a person to
read a page the system had skipped. It now reads that page and returns no-action. Atelier
previously stalled on an unread service page; it now updates a readable article without
creating a duplicate.

## Verification

```
npx tsc --noEmit                                   # clean
npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'
# 982 passed, 16 skipped
DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run \
  tests/customer-recommendations-postgres.integration.test.ts
# 4 passed (one transient failure on a first run, green on rerun)
npm run build                                      # exit 0, compiled successfully
```

New regression coverage in `tests/recommendation-regressions.test.ts`:

- unread page cannot support `does_not_answer` or an update;
- ambiguous readiness is refused, not coerced;
- missing target role is refused;
- duplicate coverage is refused;
- distinct-intent asset requires justification;
- investigation of already-supplied content is refused;
- section offsets survive repeated whitespace;
- evidence requests outside the site or for already-supplied text are refused;
- a real request → retrieval → final decision loop runs through the shared service.

## Remaining gates

- **Independent SEO/business review** of the exact saved packets and decisions. The
  outputs above are single real runs, not expert approval.
- **Held-out fresh monthly discovery** requires authorised research/source collection
  for a tenant with no existing run; the current held-out result proves extraction only.
- **Package 5 shadow/rollback proof** is implemented and unit/integration tested, but no
  full all-tenant shadow diff has been run against production data.
- Browser/accessibility review of the updated detail panel on seeded data.
- Production migration, content-populating crawl, shadow/apply reassessment, deployment.
- The legacy O1–O12 detectors and their scores remain unmigrated and are not claimed as
  AI-qualified.

No approval is implied by this document or by the green test totals.
