# SEO review of the corrected boards — 2026-11-04

## Verdict

The results are better instrumented, but they are not yet the customer-centred monthly SEO strategy the product promises. They are not the best achievable before further DataForSEO work. Several remaining limitations concern reasoning, content verification, presentation and prioritisation, not missing paid data.

This is a read-only review of the four current boards, stored crawl observations, the live Susi foreign-buyer article and current decision/display code. No provider collection, production edits, refresh or deployment was performed. Live fetches of Atelier returned no usable matching text in this review; its content is not considered independently verified here. Stored page titles establish retrieval candidates, not proof of their full coverage.

## What genuinely improved

- Existing query/page performance now reaches the analysis in windowed aggregates rather than one raw daily/device/country observation per query/page.
- The acquisition path has demonstrated exact-query enrichment rather than only related phrases derived from research.
- Unknown business verification is no longer systematically projected as missing business schema.
- Some detector summaries distinguish an observation from its possible cause.
- The system stores an impact basis and assumptions rather than pretending every item has measured search demand.

These are necessary improvements to data handling, not sufficient evidence that the recommendations are good. Test counts, more cards and lower scores cannot establish SEO usefulness.

## Current tenant assessment

### Susi: useful starting points, still incomplete strategy

The current top keyword candidate is `beachfront homes for sale under $100k`. This warrants a page/intent review: it may capture qualified budget enquiries, or visitors whose budget does not match available inventory. The action should explain realistic affordability and useful alternatives and route suitable visitors to matching inventory or advice. More clicks alone is not the business outcome.

Research topics such as closing/title safety, foreign ownership and coastal environmental risk are highly plausible concerns for international property buyers. They do not require high keyword volume to matter. But the board's absence claims are not reliable:

- The board says no candidate page addresses foreign ownership/restricted-zone land.
- The latest stored crawl includes `/post/how-to-buy-your-dream-home-in-mexico-as-a-foreigner` and a dedicated fideicomiso article.
- A live HTTP 200 fetch of the foreign-buyer article contains restricted-zone, trust/fideicomiso and transaction-cost discussion.

That establishes existing coverage, not its accuracy or completeness. A defensible recommendation could be to audit, update, clarify or consolidate the buyer guidance—not automatically create the supposedly missing answer. Legal claims require appropriately qualified review; this review does not certify the article's legal content.

Hospital queries still appear near the top. Such content could assist relocation decisions, but traffic and a geographic token do not establish commercial value. The analysis should demonstrate the connection to relocation/buyer journeys rather than automatically dismissing or prioritising it.

### Atelier: research contamination remains visible

The board contains `Corpus de sources hors sujet` and `Absence de preuve concurrentielle et de demande`. The descriptions explicitly say the sources concern Canadian parliamentary seats rather than upholstery, and that no market conclusion can be made. These are collector/research quality failures. They must not become O13 customer needs, even at low scores.

Other proposed needs—bespoke lampshade commissioning, restoration trust, project information for hospitality/interior-design clients—are plausible and potentially valuable. The correct next step is to inspect existing service, quote and professional pages. The stored inventory includes `/lampes/abat-jours`, `/devis` and `/en/b2b`. A professional-page title is not proof that the page answers every procurement concern, but it makes a confident claim of absent professional content untenable without inspection.

Blocked 429/challenge URLs continue to appear in broken-link-style technical recommendations. A crawler being rate-limited is not proof that normal visitors or Googlebot encounter a broken destination. Diagnose access separately; do not prescribe link repair without verifying the target failure.

### Casamigo: not acceptable as a finished strategy output

The known false city-page framing and Mexico City inventory findings remain in the detected board. Their impact type is `hypothesis`, but a label or lower score does not repair a contradicted premise or an irrelevant expansion suggestion. The current research run is PARTIAL with zero saved sources and zero findings; the board is displaying older research.

Existing city pages and collections are the starting point for a useful content review: whether they explain meaningful buyer comparisons, provide substantive local evidence and route visitors to appropriate listings or enquiries. Those are questions to inspect, not new claims of defects. They can be assessed from site content and business evidence without waiting for another API.

### Oceanic: promising customer needs, weak validation

Beginner safety, instructor credentials, choosing a course and training environments are relevant concerns. Some may justify clear answers, better links or reassurance on an existing course page without any volume measurement. The board must first establish what existing pages answer, whether the concern applies to the actual course, and what action is safe and accurate.

Medical and diving-safety content needs qualified subject-matter review. Snippets, anecdotal forums and neighbouring scuba topics do not support independent safety advice or prove demand for a new offer.

The latest stored completed research report still records es/MX. The resolver was subsequently corrected to select en/US, but that code correction does not retrospectively repair the research evidence. Future-correct routing and current-correct evidence are different claims.

## Why-only should generate work—but distinguish demand measurement from execution readiness

The product currently conflates three questions:

1. **Why:** Is this an evidenced customer need relevant to the business?
2. **What to do:** What specific, justified intervention would help, on which existing page or new asset?
3. **How much organic demand:** What can be estimated about search exposure and incremental traffic?

The third is useful evidence, not a universal prerequisite for the second. The internal “how” leg currently means search/technical evidence, not a complete implementation plan. A keyword measurement alone does not supply the implementation plan either.

Examples:

- Repeated prospective-buyer questions about closing costs can justify an accurate worked-example section and links to current guidance, even with no exact-query volume.
- A recurring bespoke-order objection can justify a clear measurement/quote process on an existing service page.
- A beginner's legitimate question about supervision can justify clarifying the actual course's safety process, subject to instructor review.

These are illustrative actions conditional on confirming the need, current coverage and business facts—not verified new defects in the four sites.

Missing demand evidence means **traffic impact unquantified**, not **customer value absent**. New sites otherwise suffer a circular failure: they have no impressions because they lack relevant content, then receive no recommendation because they have no impressions.

Recommended qualification:

- **Supported need + verified intervention:** actionable, with search impact measured, estimated or unknown. Low-risk improvements may proceed through normal human acceptance.
- **Supported need + uncertain coverage/solution:** a bounded investigation task: inspect named pages, check support/sales evidence, compare alternatives and return a decision.
- **Weak anecdote or speculative need:** research backlog; validate relevance before commissioning content.
- **Contradicted premise, off-topic sources or missing-data commentary:** reject as a business recommendation; retain as a system-quality/audit event.

A single precise customer request can justify a cheap correction; a large content investment or new market/offer needs stronger evidence. Require more evidence as risk, cost and irreversibility increase, not a fixed source or keyword-volume count for every action.

## Structural issues still visible in the implementation

1. `lib/funnel/scoring.ts` gives hypotheses a universal ceiling and makes measured traffic the default ordering criterion. It does not support a strong customer need with unknown traffic impact as a distinct class of valuable work. Technical and content work use unrelated numeric formulas but share one ranking.
2. `lib/funnel/impact.ts` calls forecast uplift `measured` because the baseline impressions are measured. The CTR target and future clicks are still estimates. Holding impressions constant is a useful scenario, not a hard ceiling: ranking for more variants and gaining visibility can increase impressions after a change. Ten impressions is not a scientifically established competition threshold.
3. Zero clicks over 49 impressions does not establish a title problem. With a hypothetical 4% CTR, observing zero clicks has roughly 13.5% probability (`0.96^49`). The result merits investigation, not a causal verdict or guaranteed uplift.
4. `lib/funnel/labels.ts` still prescribes consolidating URLs for O10 and refreshing a page for O11, even though detector summaries were made more cautious. The detail page uses those labels as “The plan.” The O13 label still requires keyword validation.
5. The impact-class distinction is stored but the inspected opportunity detail route does not render it. Internal fields alone do not prevent customers reading a hypothesis as a recommendation.
6. `verifySiteClaim` in `lib/research/site-claims.ts` treats an unmatched path-derived page type as supported absence. It has no proof of complete content coverage. Existing answers and offers remain unverified. This is not a semantic content audit.
7. O13/O14 records with `both` legs still have null worth volume. `applyJoin` in `lib/funnel/join.ts` attaches evidence and recomputes old score inputs without incorporating the new metric. Two edges are not two verified propositions.
8. `planAcquisition` always places observed queries before research ideas and sorts by impressions. This may repeatedly favour incidental traffic and crowd out important low-volume customer needs. Acquisition should fund decisions across existing-performance, customer-friction and discovery work, not treat one track as universally subordinate.

## What can improve before further provider expansion

No new paid data is required to:

- remove known false/irrelevant recommendations and research-quality errors from the actionable board;
- inspect existing page content before claiming missing answers;
- turn legitimate customer concerns into page-specific, risk-appropriate improvement or validation briefs;
- align UI labels with cautious detector conclusions and expose unquantified benefit honestly;
- prioritise technical work by indexability, affected templates, severity and actual eligibility rather than treating generic schema absence as growth strategy;
- verify that current snapshots were actually rebuilt with corrected language/market routing;
- run an end-to-end unseen-tenant evaluation and review recommendation quality rather than score shape.

DataForSEO can improve competitor discovery, demand triangulation, comparable SERPs and ranking coverage. It cannot establish customer value by itself, prove page-content absence or turn a flawed premise into a useful action. More data should expand and test a defensible strategy, not be used to justify the current output.

## Proceed / stop recommendation

Proceed with evaluating the data-provider architecture, but do not certify the boards as useful or the corrective plan as complete. Before expanding spend, require an evidence-backed sample of page-specific actions across the four tenants and an unseen tenant, each stating customer need, actual coverage, proposed intervention, expected benefit, uncertainty and success measure. Permit a justified “no action” result. Do not require high scores, high volume or a fixed number of cards.
