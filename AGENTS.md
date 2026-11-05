# Agent Instructions

- Read CLAUDE.md for project-level context before starting work.
- **Read `docs/crawlseo-product-operating-model.md` first.** It is the authoritative
  product requirements document: weekly crawl/opportunity/business-update research,
  monthly DataForSEO bundle, system proposes and human accepts, board lanes, AEO/GEO
  from measured DataForSEO observations. If another plan conflicts on cadence or
  priority, the product operating model wins.
- **Do not use archived docs as requirements.** `docs/README.md` lists the active
  set. Everything in `docs/archive/` is historical; read it only for audit or
  provenance.
- This project uses Next.js (App Router), TypeScript, Prisma, and Tailwind CSS v4.
- Check existing code patterns in `src/` before introducing new conventions.
## Agent task coordination

For UI/OPS implementation work, follow `docs/agent-coordination.md`: claim one
Ready issue with the actual run ID and bounded plan, keep an early draft PR,
record real tests and hand off for latest-diff manager review. Scope changes
require explicit replanning; agents stop before merge or deployment. Reuse the
shared key and existing Project, issues and CI; do not add a bot-management system.

On the shared coding host, the GitHub key is in `/SOCIAL/configs/github.env`: load
`GITHUB_PROJECTS_TOKEN` as `GH_TOKEN`. See
`docs/architecture/centralized-intelligence/agent-workflow.md` for commands. Never
print or commit the key. UI-001/UI-013 bootstrap uses `contract: null`; claims
are exclusive per issue, not across unrelated tasks.
