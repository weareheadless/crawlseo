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

1. Read the issue, its dependency state, linked spec requirements, current default
   branch and active related PRs. Read repository AGENTS/CLAUDE instructions.
2. Claim the issue through an assignee or a short comment naming the agent/run,
   branch, scope and current baseline. Check for an existing claim before work.
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

## Status and release discipline

Use Proposed -> Specified -> Ready -> In progress -> In review -> Merged -> Verified.
Blocked is a field/explicit condition with dependency links and next actor. A PR
being merged is not a cross-platform verification pass. Keep verification work
open until integration/pilot evidence exists; use separate release-gate issues
when implementation issues close at merge.

Project fields: Work ID, Area, Phase, Priority, Readiness and Status. Repository
is native metadata. Views: Roadmap, Ready for agents, Cross-repo dependencies,
Contract changes, Verification gates and Blocked. Automation should add matching
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
