# Pipeline configuration ownership

Business owns operational context: topics, audience, market, language, goals, services, competitors and brand voice. These edits do not accept or modify canonical business knowledge. Research owns providers, exclusions, recency and source limits. Settings owns cadence, enabled state, monthly budget and automation permissions.

The existing `GET /api/sites/:siteId/research-policy` remains the read contract. Existing `PUT` remains compatible. Section editors use `PATCH` on that route with `{ section, values, expectedPolicyRevision?, expectedProfileUpdatedAt? }`; only strict section fields are accepted. Missing preconditions return 428, stale preconditions return 409, and malformed/unsupported values return 400. Saves are transactional and update only named fields, preserving unrelated profile constraints. No provider diagnostics are returned. Research targeting is not canonical acceptance.

Other pages display effective values read-only and link to the authoritative editor. Do not create a second profile store or infer canonical facts from operational context. UI-045 can consume the GET values and distinguish current policy from historical run snapshots. UI-048 owns route compatibility and navigation integration.
