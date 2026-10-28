# Implementation plan

Reviewed design baseline v0.2, 2026-10-25. [Project board](https://github.com/users/weareheadless/projects/3).

Read the full design for context, then implement one bounded slice. AI requirements influence the shared model now; advanced monitoring and other platforms are not prerequisites of the first usable HelloAda flow.

## Smallest useful delivery

1. **Know and correct:** UI-001 -> UI-002/UI-003 -> UI-004/UI-008. Partial intake reaches one typed business document before design; an authorized admin corrects that same document. No provider integration needed to prove this.
2. **Research and answer:** UI-005/UI-006/UI-007 connect existing bounded research to one sourced customer question and an actual content target. No generalized knowledge graph or semantic search service.
3. **Use and prove:** UI-012/UI-016/UI-017 -> UI-018 prove one HelloAda content improvement, exact review/publication/readback, and restart-safe authority readiness. Do not rewrite the design/source pipeline.
4. **Independent follow-ups:** UI-009 schema, UI-010/UI-011 AI observations/outcomes, UI-014 Wix, UI-015 Webflow each qualify separately. Their absence is visible and does not fail the first slice.

UI-013 bridge inventory can run alongside UI-001 without customer effects. Webflow discovery waits for an explicit platform selection, not for Wix to be implemented.

## Dependency map

The following edges are generated from work-packages.json; native GitHub blocking relationships must match. Readiness is separate: Deferred work does not auto-start.

```mermaid
flowchart TD
  UI001["UI-001"]
  UI002["UI-002"]
  UI003["UI-003"]
  UI004["UI-004"]
  UI005["UI-005"]
  UI006["UI-006"]
  UI007["UI-007"]
  UI008["UI-008"]
  UI009["UI-009"]
  UI010["UI-010"]
  UI011["UI-011"]
  UI012["UI-012"]
  UI013["UI-013"]
  UI014["UI-014"]
  UI015["UI-015"]
  UI016["UI-016"]
  UI017["UI-017"]
  UI018["UI-018"]
  UI001 --> UI002
  UI001 --> UI003
  UI002 --> UI003
  UI001 --> UI004
  UI003 --> UI004
  UI001 --> UI005
  UI002 --> UI005
  UI003 --> UI005
  UI004 --> UI006
  UI005 --> UI006
  UI003 --> UI007
  UI005 --> UI007
  UI003 --> UI008
  UI003 --> UI009
  UI001 --> UI010
  UI003 --> UI010
  UI007 --> UI011
  UI010 --> UI011
  UI004 --> UI012
  UI006 --> UI012
  UI007 --> UI012
  UI001 --> UI014
  UI013 --> UI014
  UI001 --> UI015
  UI004 --> UI016
  UI006 --> UI016
  UI012 --> UI016
  UI002 --> UI017
  UI008 --> UI018
  UI012 --> UI018
  UI016 --> UI018
  UI017 --> UI018
```

## Work packages

| Work | Repo | Bounded deliverable | Dependencies | Readiness |
| --- | --- | --- | --- | --- |
| [UI-001](https://github.com/weareheadless/crawlseo/issues/15) | crawlseo | Define the first shared knowledge handoff and compatibility fixtures | None | Ready |
| [UI-002](https://github.com/weareheadless/crawlseo/issues/16) | crawlseo | Register prelaunch projects without fake sites or Google prerequisites | UI-001 | Blocked by dependencies |
| [UI-003](https://github.com/weareheadless/crawlseo/issues/17) | crawlseo | Implement sourced business knowledge revisions and correction impact | UI-001, UI-002 | Blocked by dependencies |
| [UI-004](https://github.com/weareheadless/site-agent/issues/336) | site-agent | Map confirmed intake and accepted context to shared knowledge | UI-001, UI-003 | Blocked by dependencies |
| [UI-005](https://github.com/weareheadless/crawlseo/issues/18) | crawlseo | Centralize research requests and reusable source observations | UI-001, UI-002, UI-003 | Blocked by dependencies |
| [UI-006](https://github.com/weareheadless/site-agent/issues/337) | site-agent | Route incubation research through CrawlSEO and retire duplicate dispatch | UI-004, UI-005 | Blocked by dependencies |
| [UI-007](https://github.com/weareheadless/crawlseo/issues/19) | crawlseo | Link customer questions, business evidence and actual content coverage | UI-003, UI-005 | Blocked by dependencies |
| [UI-008](https://github.com/weareheadless/crawlseo/issues/20) | crawlseo | Expose a correctable business profile through existing admin services | UI-003 | Blocked by dependencies |
| [UI-009](https://github.com/weareheadless/crawlseo/issues/21) | crawlseo | Audit schema semantics and visible business-content consistency | UI-003 | Deferred |
| [UI-010](https://github.com/weareheadless/crawlseo/issues/22) | crawlseo | Implement truthful AI access and visibility observation contracts | UI-001, UI-003 | Deferred |
| [UI-011](https://github.com/weareheadless/crawlseo/issues/23) | crawlseo | Turn AI citation gaps into shared Actions and measurable outcomes | UI-007, UI-010 | Deferred |
| [UI-012](https://github.com/weareheadless/site-agent/issues/338) | site-agent | Carry shared intelligence through design, launch and ongoing execution | UI-004, UI-006, UI-007 | Blocked by dependencies |
| [UI-013](https://github.com/weareheadless/wix-site-bridge/issues/5) | wix-site-bridge | Inventory Wix bridge compatibility and define the smallest adapter contract | None | Ready |
| [UI-014](https://github.com/weareheadless/crawlseo/issues/24) | crawlseo | Qualify Wix execution adapter with exact effect approval and receipts | UI-001, UI-013 | Deferred |
| [UI-015](https://github.com/weareheadless/crawlseo/issues/25) | crawlseo | Specify and qualify a bounded Webflow intelligence execution adapter | UI-001 | Deferred |
| [UI-016](https://github.com/weareheadless/site-agent/issues/339) | site-agent | Complete knowledge/research cutover and retire duplicate producers | UI-004, UI-006, UI-012 | Blocked by dependencies |
| [UI-017](https://github.com/weareheadless/helloada/issues/11) | helloada | Preserve one intelligence project identity across selector bootstrap and handoff | UI-002 | Blocked by dependencies |
| [UI-018](https://github.com/weareheadless/crawlseo/issues/26) | crawlseo | Verify the first HelloAda content intelligence release | UI-008, UI-012, UI-016, UI-017 | Blocked by dependencies |

## Wave 2: make the intelligence visible

Added 2026-10-27 after the UI audit in [../../ui-intelligence-experience-audit.md](../../ui-intelligence-experience-audit.md). The backend contracts from UI-001..UI-011 are closed and producing data (44,704 keywords, 293 Actions, 24 completed DataForSEO keyword runs, 7 research runs). The dashboard does not present it: the only intelligence surface is unlinked from navigation, reads as a compliance log, and the keyword/business/AEO-GEO data has no owning page.

Wave 2 changes presentation and credential resolution only. No new store, no new provider, no paid research is triggered by rendering these pages.

| Work | Repo | Bounded deliverable | Dependencies | Readiness |
| --- | --- | --- | --- | --- |
| [UI-036](https://github.com/weareheadless/crawlseo/issues/83) | crawlseo | Resolve DataForSEO readiness through the platform grant and render stored keyword research runs with results | None | Ready |
| [UI-037](https://github.com/weareheadless/crawlseo/issues/84) | crawlseo | Give the business profile a real page: knowledge document, site profile facts, provenance, correction path | None | Ready |
| [UI-038](https://github.com/weareheadless/crawlseo/issues/85) | crawlseo | Build the AEO/GEO workspace: access, identity/schema, visibility, questions, gaps, as tabs with counts | None | Ready |
| [UI-039](https://github.com/weareheadless/crawlseo/issues/87) | crawlseo | Rebuild Intelligence as an overview of counts and links; move raw action dumps behind filters | UI-036, UI-037, UI-038 | Blocked by dependencies |
| [UI-040](https://github.com/weareheadless/crawlseo/issues/86) | crawlseo | Navigation and shell correctness: link every built surface, fix the site switcher label | None | Ready |
| [UI-041](https://github.com/weareheadless/helloada/issues/19) | helloada | Website intelligence panel fed by the CrawlSEO/site-agent read contract | UI-036, UI-037, UI-038 | Blocked by dependencies |

Execution order: UI-036, UI-037, UI-038 and UI-040 are independent and may run in parallel on disjoint files. UI-039 follows because it links to the new pages. UI-041 follows the CrawlSEO surfaces and needs one bounded read contract from site-agent.

Presentation requirements for every Wave 2 issue:

- Show the real count next to every section heading, and distinguish "unknown" (no observation) from zero.
- Link each rendered fact to the record that produced it (run, crawl, observation, document revision).
- Never instruct the user to configure a credential the platform already holds.
- No placeholder or fixture rows in a customer surface; fixture-only data must say so.
- Every new page is reachable from the sidebar in the same PR that adds it.

## Existing work and execution boundaries

- CrawlSEO #3 remains the parent initiative; #14 already has an atomic research-profile endpoint in the baseline. UI-004 extends the remaining handoff rather than rebuilding it.
- Site-Agent #330 remains the migration workstream. UI-016 implements import/fence/retirement readiness; UI-018 supplies the integrated proof before separate customer activation. These must not form a circular completion gate.
- [Site-Agent #252](https://github.com/weareheadless/site-agent/issues/252) is an existing exact source-maintenance review prerequisite. It blocks source effects, not a separately validated Payload content path. No source candidate may bypass it.
- Wix Bridge #3 retains tooling/customer-artifact separation. UI-013 inventories compatibility only; implementation of demonstrated gaps belongs in bounded linked UI-014 producer/consumer PRs.
- UI-008 ships the business editor after UI-003. Coverage/research/outcome views follow real records; no fake placeholders or new parallel profile store.

## Agent pickup

Initially UI-001 and UI-013 are Ready for contract/inventory work. Other first-slice tasks wait for direct dependencies. UI-009/UI-010/UI-011/UI-014/UI-015 are deliberately Deferred. A closed prerequisite does not promote Deferred work.

Read the owning issue, its relevant requirement sections and direct artifacts, not every historical architecture plan. Verify the current baseline and claim. Start with a small PR addressing the first unmet acceptance criterion; update the same issue for coherent follow-up PRs. Do not introduce a new service/framework or expand scope silently.

## Qualification and done

UI-018 can pass for the HelloAda content slice without AI monitoring or Wix/Webflow. Later capabilities report their own actual tests/pilots and remain unadvertised until qualified. Merged and Verified stay distinct. No coding issue implicitly authorizes paid research, customer migration or production effects.

No first-release exit criterion requires every long-term requirement to be implemented. Track each requirement as first-slice, later-owned, or execution-blocked with evidence. See [review.md](review.md) for simplifications and remaining uncertainty.


## Pipeline experience implementation

Approved product sequence: Business -> Research -> Findings -> Work -> Results. Implementation plan: [pipeline-implementation-plan.md](../../pipeline-implementation-plan.md). Existing historical work above remains intact.

- [UI-042](https://github.com/weareheadless/crawlseo/issues/94): Stage contract and reusable pipeline navigation. Dependencies: none.
- [UI-043](https://github.com/weareheadless/crawlseo/issues/95): Scoped recorded lineage from evidence to verification. Dependencies: none.
- [UI-044](https://github.com/weareheadless/crawlseo/issues/96): One configuration owner and editor per setting. Dependencies: none.
- [UI-045](https://github.com/weareheadless/crawlseo/issues/97): Connect Research and Findings to inputs and Work. Dependencies: UI-042, UI-043, UI-044.
- [UI-046](https://github.com/weareheadless/crawlseo/issues/98): Consolidate drafts and agent execution inside Work. Dependencies: UI-042, UI-043.
- [UI-047](https://github.com/weareheadless/crawlseo/issues/99): Results and decision-oriented project overview. Dependencies: UI-042, UI-043.
- [UI-048](https://github.com/weareheadless/crawlseo/issues/100): Integrate pipeline navigation and qualify the journey. Dependencies: UI-044, UI-045, UI-046, UI-047.


## AEO/GEO evaluation loop

Plan: [aeo-geo-evaluation-plan.md](../../aeo-geo-evaluation-plan.md). One observation contract, two evaluators: AEO from our own surfaces, GEO from whether an engine selects and cites us. Weekly cadence, action-triggered re-ask, hard per-site caps.

- [UI-049](https://github.com/weareheadless/crawlseo/issues/109): Versioned question sets from business data and research. Depends on none.
- [UI-050](https://github.com/weareheadless/crawlseo/issues/110): Store asked answers, citations and surface metadata. Depends on none.
- [UI-051](https://github.com/weareheadless/crawlseo/issues/111): Perplexity evaluator with absence and failure states. Depends on UI-049, UI-050.
- [UI-052](https://github.com/weareheadless/crawlseo/issues/112): Google AI Overviews evaluator through DataForSEO. Depends on UI-049, UI-050.
- [UI-053](https://github.com/weareheadless/crawlseo/issues/113): Weekly evaluation runs, caps and action-triggered re-ask. Depends on UI-051, UI-052.
- [UI-054](https://github.com/weareheadless/crawlseo/issues/114): AEO/GEO evaluation surface with answer evidence. Depends on UI-050, UI-053.
- [OPS-015](https://github.com/weareheadless/crawlseo/issues/115): Pilot AEO/GEO evaluation on the two live sites. Depends on UI-051, UI-052, UI-053, UI-054.
