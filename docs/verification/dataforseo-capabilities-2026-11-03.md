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

## What this verification does and does not prove

Proven:

- the credential works, and every locale/price endpoint we need responds;
- OnPage `instant_pages` returns the 52-check payload the adapter expects, and the
  adapter's map is now correct against it;
- the AI-optimization path is per-engine, and `llm_responses` is $0.0006/call.

Not proven:

- OnPage parity against our own crawler (needs the dual-run, which needs balance);
- the `llm_responses` answer and citation shape;
- queued-task flows (`task_post` → `task_get`), which the adapters label but the
  probes did not exercise;
- backlinks payload shape (subscription exists, no call made).
