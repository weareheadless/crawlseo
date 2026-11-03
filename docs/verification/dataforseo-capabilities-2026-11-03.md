# DataForSEO capability verification — 2026-11-03

DS-01. What the platform credential can actually call, what it costs, and which
parts of our adapters the live API disagrees with.

Method: the active platform credential (`crawlseo-platform`) against
`api.dataforseo.com/v3`. Free endpoints first; then two billed calls to learn the
OnPage and AI-optimization shapes. Raw payloads were written to `/tmp/opencode/`
and are not committed.

## Account

| | |
|---|---|
| Login | `ben@jamin.io` |
| Timezone | America/Cancun |
| Balance before | **$0.1381** of $1.00 total |
| Balance after | **-$0.0637** — see the blocker below |
| Backlinks subscription | expires 2050-01-01 |
| LLM mentions subscription | expires 2050-01-01 |

The account is a $1 trial with a subscription flag for backlinks and LLM
mentions. It is not a funded production account.

## Free endpoints — verified working

| Endpoint | Result |
|---|---|
| `/appendix/user_data` | 20000, balance, rate usage, full price list |
| `/appendix/errors` | 20000, 54 error codes |
| `/dataforseo_labs/locations_and_languages` | 20000, **94 locations** |
| `/serp/google/locations` | 20000 |
| `/serp/google/languages` | 20000 |
| `/keywords_data/google_ads/locations` | 20000 |
| `/keywords_data/google_ads/languages` | 20000 |

Labs locale coverage includes France (`location_code` 2250, `fr`, 261,363,836
keywords / 19,417,993 SERPs) and the US. That covers both projects we would
dual-run.

## Prices that matter (from the account's own price list)

| Product | Endpoint | Cost |
|---|---|---|
| OnPage | `instant_pages`, `task_post` | $0.00015 per result |
| OnPage | `lighthouse` | $0.005 per request |
| Labs | `keyword_overview`, `ranked_keywords`, `serp_competitors`, … | $0.00012 per result |
| SERP | `live/advanced` | $0.002 per request |
| SERP | `ai_summary` | $0.01 per result |
| Backlinks | `summary`, `backlinks`, `referring_domains`, … | $0.000036 per result |
| AI optimization | `llm_responses` | $0.0006 per request live, $0.0002 queued |
| AI optimization | `llm_mentions/*` | **$0.001 per result, $0.101 per call as billed** |

The `llm_mentions` line is the trap: the price list says per result, but a call
with the default result limit billed **$0.101**, roughly 168× the `llm_responses`
price. DS-06 must use per-provider `llm_responses`, not `llm_mentions`.

## OnPage: works, and our check map was wrong

One `instant_pages` call on `https://atelier-harmonie.com/` returned 20000,
`onpage_score` 92.68, and **52 checks** for $0.00015.

The real check vocabulary disagrees with `ONPAGE_CHECK_MAP` in three places:

| Our key | Provider key | Polarity |
|---|---|---|
| `no_h1` | **`no_h1_tag`** | present = problem |
| `no_canonical` | **`canonical`** | **absent** = problem (`canonical: true` means the tag exists) |
| `no_schema` | no such check | — |

`has_micromarkup` is not a substitute for `no_schema`: it reports microdata only,
so a JSON-LD page (this one is Wix with JSON-LD) reports `false`. Mapping it to
`MISSING_SCHEMA` would manufacture structured-data issues that contradict our own
crawler's JSON-LD detection. It stays unmapped and is reported in
`unmappedChecks`.

All three are fixed in `lib/dataforseo/onpage-adapter.ts`, with tests, before any
dual-run spends money on a wrong comparison.

Other checks confirmed present and correctly mapped: `no_title`,
`title_too_long`, `no_description`, `no_image_alt`, `no_doctype`,
`no_content_encoding`, `high_loading_time`, `is_4xx_code`, `is_5xx_code`,
`is_redirect`, `low_content_rate`.

Also returned but unmapped (candidates for later, not parity blockers):
`duplicate_title_tag`, `duplicate_meta_tags`, `has_render_blocking_resources`,
`large_page_size`, `low_readability_rate`, `is_www`, `seo_friendly_url*`,
`high_waiting_time`.

## AI optimization: the documented path is wrong

| Path | Result |
|---|---|
| `/ai_optimization/llm_responses/live` | **404 Not Found** |
| `/ai_optimization/chat_gpt/llm_responses/live` | 20000, $0.000622 |
| `/ai_optimization/llm_mentions/target_metrics/live` | 20000, $0.101 |
| `/ai_optimization/llm_mentions/search/live` | 20000, $0.10 |

The product is addressed per engine (`chat_gpt`, and by the same pattern
`gemini`, `claude`, `perplexity`), not as one `llm_responses` endpoint. This
matters for DS-06 beyond the URL: `surface` in `ai-visibility-adapter.ts` currently
lists `llm_responses` as if it were a surface, when it is a product family. The
surface is the engine. Fixing that vocabulary touches the AEO observation model
(`perplexity_api` etc. are already in use), so it is recorded here rather than
changed silently.

The response body of the working call was not persisted before the account was
blocked, so the answer/citation shape is still unverified.

## Blocker: the account is overdrawn

The two `llm_mentions` probes cost $0.201 against a $0.1381 balance. The account
now returns:

```
POST /on_page/instant_pages → task_status 40200 "Payment Required."
```

So **every** paid verification is blocked until the balance is topped up,
including the DS-04 dual-run ($0.003 for 20 pages) and any DS-06 sample. The
free endpoints above still work.

This was my error: I called a per-result-priced endpoint without capping its
result count, and did not check the balance against the price before calling.

## DS-04 dual-run: susimacdonald.com, 30 pages

Balance restored to $51 on 2026-11-03. Two crawls of the same 30 pages, each
compared against our own crawl of the same URLs (`crawlIssue` filtered to the
provider's URL set — comparing a 30-page sample to a 200-page crawl measures
sample size, not detectors).

| | Run 1: no JS, no resources | Run 2: JS + resources |
|---|---|---|
| Cost | $0.0045 | $0.0540 |
| Provider pages | 30 | 30 |
| Our pages | 30 | 30 |
| Both agree | MISSING_ALT, MISSING_DESCRIPTION, MISSING_H1 | MISSING_DESCRIPTION, MISSING_H1, SLOW_PAGE |
| Provider only | THIN_CONTENT (30), TITLE_TOO_LONG (21) | THIN_CONTENT (30), TITLE_TOO_LONG (21) |
| Ours only | DUPLICATE_DESCRIPTION, MISSING_SCHEMA (31), MIXED_CONTENT (3), SLOW_PAGE (18) | DUPLICATE_DESCRIPTION, MISSING_ALT (4), MISSING_SCHEMA (31), MIXED_CONTENT (3) |
| `parityProven` | **false** | **false** |

Three exact agreements in run 1 (MISSING_ALT 4 = 4, MISSING_DESCRIPTION 1 = 1,
MISSING_H1 1 = 1) show the two detectors are looking at the same pages. The
disagreements are semantic, not noise:

1. **`low_content_rate` is not thin content.** It is a text-to-markup ratio. It
   fired on **30 of 30** pages, including a 1,777-word article, because the site's
   CMS ships heavy markup. Mapping it to `THIN_CONTENT` would have created 30 false
   issues on one site. Now unmapped; `low_character_count` and `small_page_size`
   were false on every page, so the provider has no usable thin-content check here.
2. **`title_too_long` is our gap, not theirs.** 21 of 30 titles exceed the
   provider's threshold (a 64-character title is flagged, 49 is not). Our crawler
   reported none. That is coverage we are missing.
3. **`SLOW_PAGE` depends on crawl conditions.** Without resources the provider saw
   none; with resources it saw 12 against our 18. Timings from different crawl
   configurations are not comparable, so this check can only be used with declared
   conditions.
4. **`MISSING_SCHEMA` and `MIXED_CONTENT` are ours only.** The provider's
   microdata check cannot see JSON-LD, and it does not check mixed content. These
   stay our detectors.
5. **`no_image_alt` flipped between runs** (4 agree without JS, 0 with JS). Under
   rendering the provider sees a different image set. Unresolved; do not switch
   this check on provider data.

Conclusion: **parity is not proven, and the read switch does not happen.** The
useful outcome is that the provider's OnPage data is *additional* evidence with
per-check semantics, not a replacement for our crawler. Our crawler stays the
authority for `MISSING_SCHEMA`, `MIXED_CONTENT` and thin content; provider
`title_too_long` covers a gap we have.

## OnPage API shape (corrected)

- There is **no `task_get`** for OnPage. Results are retrieved with
  `POST /on_page/pages` (and `summary`, `links`, `duplicate_tags`, …) passing the
  task id in the body. `GET /on_page/task_get/...` returns 404. The adapter's
  `endpoint: "task_get"` label is wrong and should become `pages`.
- `instant_pages` accepts **one URL per host per request** ("duplicate crawl host")
  and at most 20 tasks per call, so per-page sampling is one request per page.
  Site-wide comparison needs `task_post` (30 pages, $0.0045 without JS, $0.054
  with JS and resources).
- `/on_page/pages` costs nothing to read; the crawl is billed at task creation.

## Spend and cadence

| Run | Cost |
|---|---|
| `instant_pages` shape probe | $0.00015 |
| `llm_mentions` probes (my error) | $0.201 |
| `chat_gpt/llm_responses` probe | $0.000622 |
| DS-04 crawl, no JS | $0.0045 |
| DS-04 crawl, JS + resources | $0.054 |
| Balance after top-up to $51 | **$49.93** |

`llm_mentions` is capped at **once per calendar month** in code
(`lib/dataforseo/ai-mentions-cadence.ts`, tested), because one call costs $0.101 —
about 168 `llm_responses` calls. Recurring AI visibility uses `llm_responses`;
mentions is a monthly market snapshot.

## What this verification does and does not prove

Proven:

- the credential works, and every locale/price endpoint we need responds;
- OnPage returns the 52–60-check payload the adapter consumes, and the adapter's
  map is now correct against real payloads in four places;
- the AI-optimization path is per-engine, and `llm_responses` is $0.0006/call;
- OnPage and our crawler agree exactly on three issue types and disagree for
  reasons that are now named.

Not proven:

- OnPage parity (explicitly failed on 30 pages; the switch is blocked by design);
- the `llm_responses` answer and citation shape;
- backlinks payload shape (subscription exists, no call made).
