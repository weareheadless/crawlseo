# AEO and GEO evaluation plan

## Steps
- [ ] UI-049: Versioned question-set contract generated from business data and research.
- [ ] UI-050: Observation record for asked answers, citations and surface metadata.
- [ ] UI-051: Perplexity evaluator with budget guard and explicit absence states.
- [ ] UI-052: Google AI Overviews evaluator through the existing DataForSEO account.
- [ ] UI-053: Weekly scheduled runs, caps and action-triggered re-ask.
- [ ] UI-054: AEO/GEO evaluation surface with answer evidence and citation diff.
- [ ] OPS-015: Pilot evaluation on atelier-harmonie and susimacdonald.

## Why

The pipeline only becomes real when business data and research turn into improvements that can be re-checked. AEO and GEO are two evaluation modes over one loop:

business + audience + research -> question set -> asked answers -> gap -> improvement -> re-ask.

They stay separate. AEO evaluates our own surfaces: entity correctness, answerability, structured facts. GEO evaluates selection: presence, recommendation, and which URLs were cited instead. A blended "AI visibility score" hides which lever moved.

## Requirements

- AEO-01: Question sets are versioned, deterministic and derived from recorded business data and research. Every question records the business revision and research run or finding it came from, or says the source was not recorded. No hand-tuned per-site code: a new site with only business data and research must produce a first question set.
- AEO-02: An observation stores the exact prompt, provider, model surface, locale, device, asked-at timestamp, question-set version, answer text, presence verdict, mentioned brand names, cited URLs and whether an AI answer was present at all. "No AI overview", "request failed", "answer without any brand mention" and "brand absent" are four distinct states.
- AEO-03: Absence is never stored as zero mentions, and a failed request is never stored as an observation. Retries are bounded and recorded.
- AEO-04: Every run has a hard per-site cap on paid requests, a recorded spend estimate and an idempotency key. A retry loop cannot silently multiply spend.
- AEO-05: Weekly cadence is the default for both surfaces. Action-triggered re-asks are separate, capped, and linked to the action that caused them.
- AEO-06: Answers are stored so a result can be explained and diffed later. A changed answer is compared against the same question and surface, not across question-set versions without saying so.
- AEO-07: GEO reports the cited-source set and competitor overlap, not just presence. Actions derived from a citation gap name the source that won.
- AEO-08: AEO findings remain verifiable without paid calls: crawl, schema and canonical-fact comparison. Paid asking is required only for GEO and for presence confirmation.
- AEO-09: Provider credentials are resolved server-side and never exposed. The DataForSEO account already configured for research is reused for Google AI Overviews; Perplexity uses its own key.
- AEO-10: The UI shows the question set, the actual answer excerpt, the citations, the verdict, the date and the next action. It must not present a summary label without the underlying evidence.

## Work packages

| Work | Deliverable | Depends on |
| --- | --- | --- |
| UI-049 | Question-set contract and deterministic generator from business knowledge, site profile and research findings | None |
| UI-050 | Observation contract and storage for asked answers, including additive schema for answer text and surface metadata | None |
| UI-051 | Perplexity evaluator: request, parse, store, cap, classify absence/failure | UI-049, UI-050 |
| UI-052 | Google AI Overviews evaluator via DataForSEO SERP, including "no overview present" | UI-049, UI-050 |
| UI-053 | Scheduled weekly orchestration, per-site caps, re-ask on action, run receipts | UI-051, UI-052 |
| UI-054 | Evaluation surface: question set, per-surface answers, citation diff, linked actions | UI-050, UI-053 |
| OPS-015 | Live pilot on the two sites with recorded spend and an honest first result | UI-051..UI-054 |

## Pilot acceptance

atelier-harmonie and susimacdonald must both complete a first evaluation from existing business and research data without per-site code. The pilot records actual spend, the question set version, and the raw answers. A GEO action must name a cited competitor or source. A re-ask after one action must show whether the answer or citation set changed, or state that it did not.

## Boundaries

No autonomous publishing, no new provider beyond Perplexity and Google via DataForSEO, no blended score, no scraping of consumer chat UIs where no API exists. Paid runs require the configured cap and a recorded receipt. HelloAda consumes the result later; it is not part of this phase.
