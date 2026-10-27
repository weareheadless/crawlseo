# OPS-007 — AI visibility evidence and AEO relevance

## Scope and provenance

This is a production verification report for the internal `ada-provision-test`
project (`cmuls0r2n0002oyqfmv86i92z`) and site
(`cmuls0r2v0004oyqfcbjnqwxq`). The site domain at verification was
`example.com`. It is not a customer outcome or a real-provider measurement.

The imported records are explicitly labelled fixture data: source kind
`operator_manual`, reference `fixture:ops-007-internal-test-only`, and model
surface `Perplexity web answer (fixture)`. The observations exercise the
`ai-visibility-export-v1` Perplexity adapter; they are not exports from
Perplexity and establish no real-world visibility.

## Production import and page evidence

The importer is the library function
`importAIVisibilityExport` in `lib/research/ai-visibility-import.ts`. I found
no production API route or operator CLI/script invoking it: the provider
capability inventory points to the importer, while repository search found only
the function, its tests and the UI. Verification therefore used a temporary
one-off script calling that documented function with the production Prisma
client; the script was removed and is not a supported operator workflow. This
is an operational gap and should be tracked as a follow-up (a narrow, authorized
operator entrypoint with audit/provenance controls, not a second import path).

The fixture envelope supplied provider `perplexity`, model surface, question
set version `ops-007-fixture-v1`, observed date `2026-10-27`, denominator 5,
and three questions. The importer persisted provider, model surface, question
set version, observed date, denominator, source reference, coverage and the
three independent metrics: mentions, recommendations and citations.

Import behavior was verified against production:

- **3 questions per import**: 2 observations with an answer and 1 deliberately
  absent answer. Thus 2 are observed and 1 is unknown, not zero.
- Re-importing an identical export returned the same records/versions (no
  duplicate or version increment).
- Changing one observation created its next immutable version (v2); unchanged
  observations remained at their existing version.
- After reconciliation of early test attempts, production retained only the
  `ops-007-fixture-v3` test set: **3 rows at v1 and 3 at v2**. The earlier v1/v2
  test-set duplicates were removed by the coordinator. The rows demonstrate
  two answered questions and one absent answer; the absent-answer metrics render
  as **Unknown** for mentions, recommendations and citations, with the explicit
  “provider did not supply an observed answer; this is not zero” explanation.

The authenticated Intelligence page renders the observation group, question,
question-set version, observed date, provider-reported denominator, metric
split, and unknown-not-zero message. The page check used a short-lived session;
the coordinator reported cleanup of two leftover session rows from earlier
attempts. This is an internal production UI check, not a live-provider check.

## Relevance for owner sign-off

**Potentially actionable:** the existing AEO Action for missing identity
JSON-LD is a concrete, inspectable technical task. An owner could review whether
the business identity/schema is correct and approve an implementation after
seeing the exact proposed data and validation. The related question-coverage
Actions may also be useful if each resolves a real customer question with
confirmed facts and a reviewable content change.

**Noise / not actionable from this evidence:** the fixture's apparent brand
mentions, recommendations and citations are invented test evidence. They must
not be interpreted as a ranking, share-of-voice, competitor comparison or
reason to change content. The denominator is a provider-reported fixture value,
not an estimated sample size for the market. The unanswered test question is
unknown, not proof of absence. Technical access/crawl evidence likewise does
not demonstrate that answer engines include or recommend the site.

**Needed before this is worth paying for:** an authorized repeatable import or
provider integration; genuine dated observations with provenance and a defined
question set/sample protocol; enough repeated samples to show variability and
trends; explicit provider/model/locale and competitor context where licensed;
clear separation of observed, unavailable and unknown states; and evidence
linking each proposed Action to the exact observation and a measurable outcome.
The product should report coverage and limitations, not imply causal lift from
small counts. No pricing/value claim is established here.

This assessment is evidence for the owner's decision only. It does not approve
the JSON-LD change, content edits, publication, or a paid plan.

## Acceptance boundary

This verifies a fixture import, idempotency/version behavior, and its owner-page
render. It does **not** verify a genuine Perplexity export, an operator path, an
owner's relevance judgment, publication, or customer value. Owner sign-off and
an operator-entrypoint follow-up remain outstanding.
