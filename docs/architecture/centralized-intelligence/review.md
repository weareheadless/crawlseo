# Architecture review — 2026-10-25

Result: retain the shared-intelligence concept and existing platform execution
owners. Tighten delivery into a first HelloAda content slice, then independently
qualify deeper intelligence and other platforms. This is a design/backlog review,
not a runtime or live-product acceptance report.

## Findings and corrections

| Finding | Why it matters | Correction |
| --- | --- | --- |
| UI-001 specified every future contract before any implementation | Encourages a speculative platform design | Define the first project/knowledge handoff and compatibility fixtures; record future boundaries without designing all providers |
| Logical entities looked like a normalized business ontology | Many tables/services could be built before a useful flow | Start with one typed business document/revisions and existing research/Action records; normalize only for demonstrated queries |
| Admin editing waited for research and coverage | Delays the user's simplest way to inspect/correct Ada | UI-008 depends only on knowledge storage; add later views when their real data exists |
| First qualification waited for schema, AI monitoring and Wix | No bounded first success; unrelated capabilities become critical path | UI-018 verifies the HelloAda content slice; each later capability has its own gate |
| Webflow depended on the Wix implementation | Accidental technical coupling between platforms | Both consume the common contract; Webflow stays Deferred with an explicit owner/capability discovery gate |
| Source review was assumed usable because code existed | Could produce unreviewable source candidates | Link existing Site-Agent #252 as a source-capability prerequisite; first slice uses a separately proven Payload content path |
| Partial intake versus accepted context was underspecified | Research could require a completed design or overwrite accepted facts | Permit predesign working snapshots, preserve origin/status, and pin accepted inputs for candidates |
| Fine-grained invalidation was implied before basic revision refresh | Creates an unnecessary dependency engine | Refresh the typed document and recheck bounded pending work first |
| Task paths were abbreviated and views did not match the actual board | Agents could search the wrong module or assume missing automation | Expand repository-relative paths and document the configured views |
| Deferred work was merely blocked | Could be picked automatically when one prerequisite closes | Add explicit Deferred readiness; only UI-001/UI-013 start Ready |
| Migration and qualification completion blurred implementation versus activation | Risks circular gates or unauthorized customer changes | UI-016 delivers import/fence/cleanup readiness; UI-018 proves the disposable journey before any separate live activation |

## Solid parts retained

- One project identity before domains/analytics, with tenant-scoped access.
- One canonical business/research authority after explicit migration; reuse intake
  provenance and existing owner workspace rather than adding another questionnaire.
- Shared question/evidence/content relationships designed for AI usefulness and
  later AI observation, without claiming schema guarantees citations.
- Existing jobs, events, budgets and exact candidate approval/receipts.
- Separate authority for CMS content, private conversations, credentials and
  platform effects, including immediately-live Wix embed updates.
- Retry, stale input, partial effect and cross-project failure cases as acceptance.

## Agent entry and completion

Use [implementation-plan.md](implementation-plan.md) to select a delivery slice,
then the owning issue and its direct prerequisites. The reviewed plan preserves
all 18 work IDs and their histories; it narrows scopes and removes false blocking
dependencies instead of creating a competing backlog. Later monitoring/schema/
Wix/Webflow work remains explicit and independently testable.

First meaningful proof: one intake -> one correctable business document -> one
sourced customer question -> one supported content update -> one exact review
and publication receipt -> verified readback. A deployment/owner review failure
is an actual blocker, not permission to bypass the existing pipeline.

No finite code review can prove that every future concern is known. The remaining
concrete design questions belong in UI-001 (first-slice schemas/identity/scopes)
and the later provider/platform capability tasks; they are visible prerequisites,
not hidden assumptions. Implementation and pilots must supply the runtime proof.
