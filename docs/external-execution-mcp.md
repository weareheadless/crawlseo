# External execution over MCP

How an agent outside CrawlSEO finds work, does it in a site's own repository, and reports
back — without pretending a person confirmed anything.

Companion to `docs/site-agent-connector-contract.md`, which covers the HelloAda runtime
connector. This document covers the **MCP** surface, which is project-scoped and is what a
developer's own agent (Claude Code, Cursor, an internal tool) connects to.

## 1. Why this exists

The built-in agent has to work for every tenant, so it optimises for the narrowest shared
behaviour. That is the right default for a product, and the wrong ceiling for a site whose
repository has its own conventions, its own deploy lane and its own idea of a good page.

An external executor is the escape hatch: the client already knows the codebase, so
CrawlSEO supplies the **decision** (what to change, which page, which queries, why it is
worth doing) and the client supplies the **execution**. Neither side has to model the
other.

The most common executor is an agent session running **on this host**, beside the site
checkouts and the Wix bridge. That case needs no credential and no network hop, so it has a
second entry point — `scripts/opportunity.ts` — over the same library functions. See §8.

## 2. The tools

All four are project-scoped: one credential is one tenant. See §6.

| Tool | Scope | Does |
| --- | --- | --- |
| `seo_list_opportunities` | `connector:read` | The board, in product order, with page/queries and delivery history |
| `seo_get_opportunity` | `connector:read` | One row as a work brief: action, success measure, target pages |
| `seo_get_execution_config` | `connector:read` | Repository, branch, deploy doc, adapters — and what is missing |
| `seo_decide_opportunity` | `connector:write` | Accept, park or reject — with the person who decided |
| `seo_report_work` | `connector:write` | Records a delivery and moves the opportunity |

The read order is deliberate and is not the caller's to change: **evidence class, then
score, then oldest first.** A client that re-sorted by score would put a projection above a
measurement, which is the inversion `evidenceClass` exists to prevent.

## 3. The loop

```
seo_list_opportunities            → what is worth doing, best-evidenced first
seo_get_opportunity <id>          → which page, which queries, what change, how success is measured
seo_get_execution_config          → which repository, which branch, which deploy document
seo_decide_opportunity <id>       → accept (creates the task), or park/reject with a reason
        ... the client does the work in the site's own checkout ...
seo_report_work                   → commit / PR / live URL + why, and the row moves
```

Step 3 is not optional decoration. A site's deployment process is documented *in that site's
repository* (`DEPLOYMENT.md`, `AGENTS.md`), and that document is the authority. CrawlSEO
points at it with `deployDocPath` and never restates it: a copy would drift, and then
contradict the thing it copied.

## 4. What a delivery must carry

`seo_report_work` refuses four things on purpose:

| Refused | Because |
| --- | --- |
| no `executorId` | an unattributed delivery cannot be followed up |
| no `note` | "why is this done" is the next reader's first question, and a status does not answer it |
| no locator | a claim nobody can check is worse than an open row |
| prose as `commitSha` | a commit is a hex id; anything else is a claim, not a reference |

A locator is one of `commitSha`, `pullRequestUrl`, `deployedUrl`. Work whose evidence has no
locator — a Wix editor placement, a DNS record, a redirect rule — is reported with
`workKind: "external"`, and the note becomes the record.

## 5. Attribution, and what did not change

An external agent **may** move an opportunity to `delivered`. That is the decision this
surface implements, and it is recorded as:

```
executorKind: "external_agent"
executorId:   <the client's own identity>
```

**`Task.humanConfirmedBy` is never written by this path.** That field records that a person
confirmed execution, and the funnel plan's rule is that a person can always answer "who did
this". Writing an agent's name into it would make *a person confirmed* and *an agent
reported* indistinguishable — the one question an auditor asks first. Deliveries live in
`OpportunityExecution` instead, which is why a delivered row can show both its human
decisions and its agent deliveries without either overwriting the other.

A delivery is refused against a `detected` row: nobody has accepted it yet, so delivering it
would skip the human decision the funnel exists to keep. A `delivered` row accepts a
follow-up delivery but refuses to move back to `in_progress` — progress on finished work is
a new opportunity or a task step, not a silent status walk.

## 6. Project scope is the boundary

MCP credentials carry a `projectId`. `seo_get_project` returns *the* authenticated project,
so one connection is one tenant. "Find a tenant" therefore happens when the connection is
created, not inside a tool call.

A workspace-scoped credential would change that, and it is deliberately not added here: it
is a new scope with its own blast radius, and nothing yet needs it.

## 7. Configuring a site

`siteDeliveryConfig` must carry the facts an executor can actually use. There are **two
lanes**, and either one makes a site executable:

| Lane | Field | Use |
| --- | --- | --- |
| local checkout | `repoPath` | an agent session on this host, beside the checkout |
| clone | `repoUrl` | a client connecting from elsewhere |

Both are reported together, because they are not interchangeable: a local path is useless to
a remote client and a clone URL is not a checkout.

A local checkout is **verified**, not trusted — the directory must exist and be a git work
tree when the config is read. A stale path and no path are the same thing to a caller, so the
difference is reported rather than assumed.

`deployDocPath` names the site's own deployment document. It is looked for at the stated path,
then in the site repository, then in the bridge's site directory — and the one that resolves
is reported. A site with no deploy document is refused, because knowing where the code is but
not how a change reaches production is how a change gets lost.

Live state as of this writing:

| Site | Lane | Deploy doc | Executable |
| --- | --- | --- | --- |
| susimacdonald | local, verified | found (bridge) | yes |
| atelier-harmonie | local, verified | **none** | no |
| the other six | none | none | not configured |

Atelier is the honest refusal: it is checked out and deployable in principle, but nothing in
its repository or bridge directory says how a change ships.

## 8. The local executor

An agent session on this host does not need MCP at all. `scripts/opportunity.ts` is a thin
CLI over the same library functions — the same rules cannot drift between the two lanes,
because there is only one implementation:

```
npx tsx scripts/opportunity.ts list    --project <id> [--status detected] [--limit 20]
npx tsx scripts/opportunity.ts show    <opportunityId> --project <id>
npx tsx scripts/opportunity.ts config  --project <id>
npx tsx scripts/opportunity.ts accept  <opportunityId> --by "<person>" --project <id>
npx tsx scripts/opportunity.ts park    <opportunityId> --by "<person>" --reason "<why>"
npx tsx scripts/opportunity.ts deliver <opportunityId> --by "<agent>" --note "<why>" \
      --commit <sha> | --pr <url> | --url <live url>
```

This follows `scripts/deliver-page.ts`: the caller is local, the work happens locally, and no
credential has to be minted, stored or rotated to do it. With several active projects,
`--project` is required — guessing which tenant a piece of work belongs to is not a decision a
CLI should make.

## 9. Two identities, on purpose

`seo_decide_opportunity` requires `decided_by`, and `seo_report_work` requires `executor_id`.
They are not the same field because they are not the same act:

- **`decided_by`** is the person who decided this work is worth doing. An agent has no
  standing to decide what a business should invest in.
- **`executor_id`** is who did the work.

Keeping them separate is what makes the record read *"Sam accepted it, the session delivered
it, here is the commit"* instead of attributing a business judgement to a tool. Both are
required; a tool with no name attached is not an executor, it is an unsigned change.
