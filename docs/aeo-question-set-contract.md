# AEO question set contract

`lib/aeo/question-set.ts` exports the pure `generateQuestionSet(input, options?)` function. Types are exported from `lib/aeo/question-set-types.ts` for UI-050/051/052 consumers. It does not access Prisma, call a provider, or persist data.

## Input and output

Input accepts optional business knowledge (`fields`, `acceptedRevision`, and `documentId`), a `SiteProfile`-shaped profile (audience, topics, services, market, country, language/locale), research runs and findings, and existing keyword evidence. Values can be plain strings/lists or business-knowledge `{ value }` facts. The output is provider-agnostic: `contract: "aeo-question-set/1"`, SHA-256 `version`, locale, questions, and set-level provenance. Callers must pass the historical accepted revision belonging to the supplied business document; the generator never substitutes a current revision.

Each question has a stable content-derived `id`, text, one of `discovery | comparison | suitability | local | trust_risk`, and source provenance. Provenance identifies business revision, research run/finding, profile input, or explicitly `not_recorded`. Locale carries country and language (or locale fallback).

The default maximum is 12 questions; `options.limit` can request fewer or more, capped at 20. Empty values are skipped, and normalized duplicate prompts are emitted once. If no business data exists, output has no questions and `emptyReason: "no_business_data"` rather than fabricated prompts.

IDs and versions are deterministic SHA-256-derived values; no clock, randomness, provider, or database is involved. The version tracks the generated contract content, locale and provenance. Consumers should retain this version with observations so answer comparisons remain attributable to the exact question set.
