# Agent Instructions

- Read CLAUDE.md for project-level context before starting work.
- **Read `docs/crawlseo-product-operating-model.md` first.** It is the authoritative
  product requirements document: weekly crawl/opportunity/business-update research,
  monthly DataForSEO bundle, system proposes and human accepts, board lanes, AEO/GEO
  from measured DataForSEO observations. If another plan conflicts on cadence or
  priority, the product operating model wins.
- **Then read `docs/crawlseo-simplified-execution-plan.md`.** It is the active
  implementation plan: data layers, multiple AI calls, minimal validation, pilot
  phases. Do not rebuild the old packet/decision/shadow machinery.
- **Do not use archived docs as requirements.** `docs/README.md` lists the active
  set. Everything in `docs/archive/` is historical; read it only for audit or
  provenance.
- This project uses Next.js (App Router), TypeScript, Prisma, and Tailwind CSS v4.
- Check existing code patterns in `src/` before introducing new conventions.

## AI owns context; code owns facts and contract

SEO is contextual judgment. The model reads the business, the audience, the
query set and the pages, and decides what a topic means. Code must not guess
that meaning. This project already paid for the lesson: anchor groups,
brand-split sanitization, service-term injection, head-term claiming,
place-group patching, page-type inference, page-term coverage and scope
inference each fixed one tenant and became the next tenant's bug.

**The model decides:** what a topic is, its market, its need and its language;
which queries belong to it; the owner page and the page type; the offer key;
whether a brand topic exists; whether a topic is local, national or
international; and the forms buyers search (singular/plural, word order,
synonyms).

**Code decides only:**
- contract shape: a market topic has a need, a local/national topic has a place
  or local-intent phrase, every topic has an owner page and a page type;
- arithmetic: which queries match which topic, what is owned, context-only or
  unowned, distinct volume, word count, whether a page exists;
- transport: batching, sampling with a reported count, rendering.

**Never add a deterministic fallback for a semantic field.** If the model omits
or contradicts a field, reject the topic and re-propose once with the reason.
Do not choose an owner page by path-token overlap, classify a page from a
hardcoded list of `blog`/`product`/`category` words, derive need terms from
query tokens, fuzzy-match an offer key, create a brand topic programmatically,
add plural or word-order variants to the matcher, or infer scope from
`coverageKind` or from the product type.

Normalize only what is a fact in every language: case, accents and whitespace.
Plural agreement, word order and synonyms are the model's job; ask for the
forms buyers search in the prompt. The model knows `lampes artisanales` is the
plural of `lampe artisanale` and `mayan riviera` is `riviera maya`. If it misses
one, the unmapped table shows it and the next proposal includes it. The system
does not need to be perfect; it needs one honest feedback loop.

**Before writing a helper, ask: is this a fact or a judgment?** A judgment
belongs in the prompt or in a contract rejection, not in code. A fact is
allowed. The only loop is the single re-proposal; any other loop must compute a
fact, not decide a meaning.

The test for a structural change: remove the helper and see whether the system
still produces a complete taxonomy, or an honest report of what is missing. If
it produces a guessed taxonomy, the helper was a bandaid.

## Universality is non-negotiable

This is a multi-tenant system. Every rule in `lib/` must work for any tenant,
any language, any market and any business model. No tenant names, domains,
cities, page paths, service words or per-tenant branches. If a rule needs an
exception for one tenant, the rule is wrong: the exception belongs in the
tenant's data (taxonomy, market scope, business knowledge) or in the model's
prompt, not in the code.

The test is a new tenant, not the current four. Add a tenant with a different
language, a different market and a different business model; the code path must
not change. Only the data and the model's context change.

A local fix that makes one tenant better but adds a tenant-shaped branch is
rejected, even when it works. A general rule may still be imperfect for a
tenant; the model and the human review handle that context. Do not encode the
exception.

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

## No silent truncation

Every bound in the research pipeline either processes the whole input (batching
is fine, it is transport) or reports what it dropped. A cap that hides data is a
bug, not a tuning choice: `pages.slice(0, 40)` once hid a real page from the
taxonomy and produced a proposal to create a page that already existed.

- Do not cap a list that decides which topics, pages or evidence the model sees.
  Batch it, or send it whole.
- When a payload bound is unavoidable (model context), name it in a constant,
  and push the dropped count into the run result (`truncations`) so the report
  shows "N items were not sent".
- Selection by relevance (top impressions, latest crawl) is not truncation, but
  it must be stated in the code comment.
- No tenant names, domains, cities, page paths or service words in `lib/`. If a
  value describes one business, it belongs in the database (taxonomy, market
  scope, business knowledge) or in a test fixture.
