# Agent Instructions

- Read CLAUDE.md for project-level context before starting work.
- This project uses Next.js (App Router), TypeScript, Prisma, and Tailwind CSS v4.
- Check existing code patterns in `src/` before introducing new conventions.
## Agent task coordination

For UI/OPS implementation work, follow `docs/agent-coordination.md`: claim one
Ready issue with the actual run ID and bounded plan, keep an early draft PR,
record real tests and hand off for latest-diff manager review. Scope changes
require explicit replanning; agents stop before merge or deployment. Reuse the
shared key and existing Project, issues and CI; do not add a bot-management system.
