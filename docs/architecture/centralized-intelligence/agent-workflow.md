# Coding-agent and project-management workflow

## Source of truth

The specification defines intended behavior. Issues define bounded deliverables.
GitHub Project fields summarize work; PRs and test/release receipts establish
evidence. A board status is not a customer approval or publication instruction.

The Project spans CrawlSEO, Site-Agent, HelloAda and Wix Bridge. Webflow stays a
planned capability until its repository/adapter and pilot are established.
Canonical initiative: CrawlSEO #3; preserve #14 and Site-Agent #330 as existing
workstreams rather than duplicating their histories.

`work-packages.json` provides stable work IDs, issue URLs and dependency edges
for agent tooling. Its initial readiness is a planning snapshot, not a live
dispatch authorization; check GitHub issue relationships and active claims.

## Issue contract

Every implementation issue must contain:

- Stable work ID and linked requirement IDs.
- Problem/current behavior and expected result.
- Owning repository and relevant code/test paths.
- In-scope changes, explicit boundaries and prerequisites.
- Dependency issue links and expected producer/consumer contract version.
- Observable acceptance criteria, including negative/retry cases.
- Test commands or test suites; required migration/compatibility evidence.
- Definition of done and deployment disposition.

Do not mark an issue Ready until prerequisites are verified, contracts are
specific, and no consequential product question remains hidden. A design task
can be Ready to produce a reviewed schema; dependent coding remains blocked.
Never assign an arbitrary human as owner just to populate a field.

## Agent pickup and PR checklist

The lightweight operational protocol and manager commands are implemented in
[the shared coordinator](https://github.com/weareheadless/site-agent/blob/21f1bc35e1fd9ebb537667489ce41d5370cdc13a/docs/agent-coordination.md).
[OPS-001](https://github.com/weareheadless/site-agent/issues/341) tracks adoption
across the four repositories. Reuse the existing shared key; no separate identity
system, worker service or automatic merger is introduced. The coordination PRs are merged; templates and checks are on each default
branch. Task-format feedback is not code review;
the manager checks current CI and the actual diff before merge.

1. Read the issue, its dependency state, linked spec requirements, current default
   branch and active related PRs. Read repository AGENTS/CLAUDE instructions.
2. Use the shared coordinator claim command with the actual worker run ID,
   branch, scope and current baseline. The manager may submit the claim on the
   worker’s behalf. An assignee or plain comment alone does not satisfy the checker.
3. Use an isolated `codex/<work-id>-<description>` branch/worktree. Keep changes
   bounded to the issue; cross-repo code needs separate linked PRs.
4. Reuse application services/contracts. Add failing behavioral tests for meaningful
   implementation changes, then focused verification and required repo checks.
5. PR body links the owning issue, requirement IDs, related consumer PRs, contract
   version, validation and rollout/migration impact. Include negative/retry evidence.
6. A changed shared contract updates this spec/ADR or the approved contract package
   and identifies every consumer. Never patch only one side silently.
7. Report actual test results and unresolved limitations. Do not describe a mock
   provider, fixture or public health response as end-to-end product validation.
8. Leave production changes to the existing reviewed release path and exact target
   authorization. Do not expose credentials or put tenant private data in issues.

Start with [implementation-plan.md](implementation-plan.md), then read only the
owning issue's requirement sections and direct dependencies. The complete spec
is context; it is not the scope of every task. Source maps are starting points,
not an instruction to review or refactor the whole repository on every pickup.
Keep existing working behavior when a task can be satisfied by a small adapter.

For each pickup, record a short handoff: issue/work ID, current baseline, consumed
contract commit, existing code being reused, bounded change, tests, and remaining
blockers. Stop at the issue's acceptance boundary. If implementation reveals a
new requirement, update the owning issue/spec rather than adding a parallel
workflow or silently expanding the PR. Long work packages may use a checklist of
small PRs on the same issue; add a sub-issue only for independently owned work.

The architecture on `main` is the reviewed design baseline, not an implemented
API. **UI-001 produces the first concrete contract**; it and UI-013 use
`contract: null` in their claims and PRs. Neither needs a pre-existing
implementation-contract commit. Downstream implementation pins the reviewed
contract delivered by UI-001 after merge, with passing compatibility fixtures.
Design acceptance does not authorize a breaking schema, credential or customer
cutover. A dependency is satisfied by its artifact and tests, not merely a closed
issue.

Claims are exclusive **per issue**, not globally. UI-001 and UI-013 may run
independently on separate branches with separate claims. The manager serializes
claim writes to avoid a race; this does not serialize unrelated coding tasks.
No issue automatically launches a coding agent.

### If the worker has no GitHub shell credentials

The manager uses the existing shared key to inspect readiness, submit the worker’s
claim and publish/update its PR. The worker only needs the agreed main-based
checkout, issue/claim details and local tools to implement and test. The manager
can handle fetch/push when that worker’s environment lacks network access. Do not
request a new token, copy a personal token into the repository or application env,
or treat a missing worker `GH_TOKEN` as a missing product prerequisite.

When shell transport is available, run the coordinator from a checkout pinned to
`21f1bc35e1fd9ebb537667489ce41d5370cdc13a` in Site-Agent. Supply the shared key
through the environment or the host’s existing credential loader. Repository access
and sandbox network permission are separate: use the normal permission mechanism
for an authorized fetch/push. A credential cannot override sandbox restrictions.
Before delegating, the manager verifies these operations and supplies exact
checkout, branch, baseline and checker paths; a proposal-branch checkout is not
the implementation workspace. If a remote environment cannot access this host’s
paths, prepare the equivalent there or keep GitHub transport with the manager.

## Status and release discipline

Use Proposed -> Specified -> Ready -> In progress -> In review -> Merged -> Verified.
Blocked is a field/explicit condition with dependency links and next actor. A PR
being merged is not a cross-platform verification pass. Keep verification work
open until integration/pilot evidence exists; use separate release-gate issues
when implementation issues close at merge.

Project fields: Work ID, Area, Phase, Priority, Readiness and Status. Repository
is native metadata. Configured views: All work, Ready for agents, Blocked,
Deferred capabilities, AI visibility, Verification gates and Delivery board. Later platform work is
explicitly Deferred, not merely waiting to become ready when a contract closes.
Automation should add matching
issues/PRs and reflect review/merge status only when configured and tested; never
mark Verified automatically from merge. Use actual issue relationships for
blocking/sub-issues where permissions allow, plus readable dependency links.

## PM review and changes

At each planning checkpoint inspect dependency completion, stale claims, competing
PRs, contract versions, unsupported platform promises and remaining acceptance.
Post meaningful changes with evidence; avoid recurring unchanged status noise.
New scope updates the spec and backlog before coding. Preserve superseded plans
as historical references and identify which requirements replaced them.

There is no unattended manager/worker running merely because this file exists.
Agent dispatch or recurring review automation must be explicitly configured and
authorized. Until then, agents pick linked Ready issues and PM updates occur in
the active work session.

## Existing execution blockers

Site-Agent #252 tracks unfinished exact source-maintenance review. Link it as a
capability prerequisite if working on source effects; do not invent an initial-
design parent, bypass review, or block unrelated Payload content work on it.
Every executor capability must have proof of its own preparation/review path.
Keep UI-018 focused on the first HelloAda content proof. Wix, advanced AI and
Webflow qualify in their own tasks; no platform is advertised from a mock pass.
