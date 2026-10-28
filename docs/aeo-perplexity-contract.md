# Perplexity evaluator contract (UI-051)

`lib/aeo/perplexity.ts` exports `evaluatePerplexityQuestion(input)`. It makes one server-side `POST` to Perplexity chat/completions using the configured `PERPLEXITY_API_KEY`, supplied question and locale, and the selected model (default `sonar`). Its stable neutral instruction does not require or steer toward a brand. `promptText` retains the exact user prompt for a successful observation.

The module returns a local normalized result with `succeeded`, `answer_absent`, `request_failed`, `rate_limited`, or `over_budget` status. Failed requests never become answer absence. HTTP 429 is rate limited, HTTP 402 is over budget, and other HTTP errors, timeouts, oversized responses, and invalid JSON are request failures. It does not retry. Response bytes and request time are bounded. The API key is read only from server process environment and is never included in results or logs.

Successful results include answer text, provider model/request IDs, validated and deduplicated HTTP(S) citation URLs, usage token counts and provider-reported cost when available. Mentioned brand names are case-insensitive matches against the supplied brand and aliases; `[]` means a supplied target did not occur, `null` means no target was supplied (or no answer was present). No database writes, scheduling, or shared provider result contract are part of this module.

Tests mock `fetch`; running them makes no live provider calls or spend.
