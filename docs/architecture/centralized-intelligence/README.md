# Centralized business intelligence and execution

Status: reviewed proposal, v0.2, 2026-10-25. The first release is a bounded
HelloAda content slice; the full design includes later AI and platform work.

[GitHub Project: Unified Business Intelligence](https://github.com/users/weareheadless/projects/3)

This is the canonical cross-repository design for intake, business knowledge,
research, SEO/AEO/AI visibility and execution through HelloAda, Wix and later
Webflow. It defines the whole product before implementation is divided into
phases. Publishing this proposal does not activate customer automation.

- [Architecture and requirements](spec.md)
- [Code inventory and baseline](code-inventory.md)
- [Implementation plan](implementation-plan.md)
- [Coding-agent workflow](agent-workflow.md)
- [Machine-readable work packages and dependencies](work-packages.json)
- [Architecture review findings and simplifications](review.md)
- [Requirement ownership and delivery scope](requirement-coverage.md)
- [Decision 0001: authorities and shared intelligence](decisions/0001-authorities.md)

Existing coordination anchors:

- [CrawlSEO #3: shared research backend and execution connectors](https://github.com/weareheadless/crawlseo/issues/3)
- [CrawlSEO #14: incubation research-profile handoff](https://github.com/weareheadless/crawlseo/issues/14)
- [Site-Agent #330: connector migration and Growth cleanup](https://github.com/weareheadless/site-agent/issues/330)
- [Wix Bridge #3: shared tooling versus customer artifacts](https://github.com/weareheadless/wix-site-bridge/issues/3)

Those issues retain their history. This specification extends their scope to
prelaunch knowledge and AI visibility; it does not imply that their outstanding
implementation or tenant acceptance is complete. Existing exact approval,
credential, CMS and release contracts remain binding. The proposed transfer of
business-knowledge authority requires its own migration before taking effect.

Change this reference through a PR. Cite stable requirement IDs in implementation
issues and PRs. Breaking ownership or wire changes need a decision record,
consumer impact analysis and compatibility plan. Do not copy the full spec into
other repositories: link to this directory and pin a reviewed commit for builds.
