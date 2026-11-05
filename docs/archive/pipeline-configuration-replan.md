# UI-044 reviewed configuration save replan

The first worker correctly stopped before unsafe section saves. The existing full-form PUT schema defaults omitted fields, and its writer replaces constraints JSON. Inspection confirms the writer already persists SiteProfile; no separate business-profile store is needed.

Manager authorizes an additive PATCH on the existing research-policy route with `{section, values, expectedPolicyRevision?, expectedProfileUpdatedAt?}`. The original PUT stays compatible. A new `lib/research/configuration-sections.ts` service applies only explicitly supplied, section-owned fields in a transaction, preserving unrelated fields and unknown constraints keys. Missing or stale record preconditions fail closed (428/409); strict whitelists reject empty, unknown and wrong-section writes (400). Creation-only defaults may not reset existing values. Use compare-and-swap or bounded serializable retry to protect concurrent cross-section edits. Existing authorization remains unchanged.

Ownership is explicit: Business owns operational topics/audience/market/language/goals/services/competitors/brandVoice; Research owns providers/exclusions/recencyDays/maxSources; Operations owns cadence/enabled/monthlyBudget/autoDraft/autoAgent. Existing legacy goals/constraints mirrors remain coherent when changed. Canonical knowledge acceptance is never implied by these edits.

The precise claim expands to the existing route, the new service and `tests/pipeline-configuration-route.test.ts`. Required tests include authorization, partial saves without defaults, hidden/unknown constraints preservation, stale and concurrent saves, absent records, wrong-section fields, unsupported providers and full-form PUT compatibility.

The expanded scope and release/reclaim events are recorded on issue #96 with the same actual worker session ID. No migration, paid provider call or production deployment is authorized.
