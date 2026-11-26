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

## 2. The tools

All four are project-scoped: one credential is one tenant. See §6.

| Tool | Scope | Does |
| --- | --- | --- |
| `seo_list_opportunities` | `connector:read` | The board, in product order, with page/queries and delivery history |
| `seo_get_opportunity` | `connector:read` | One row as a work brief: action, success measure, target pages |
| `seo_get_execution_config` | `connector:read` | Repository, branch, deploy doc, adapters — and what is missing |
| `seo_report_work` | `connector:write` | Records a delivery and moves the opportunity |

The read order is deliberate and is not the caller's to change: **evidence class, then
score, then oldest first.** A client that re-sorted by score would put a projection above a
measurement, which is the inversion `evidenceClass` exists to prevent.

## 3. The loop

```
seo_list_opportunities            → what is worth doing, best-evidenced first
seo_get_opportunity <id>          → which page, which queries, what change, how success is measured
seo_get_execution_config          → which repository, which branch, which deploy document
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

`siteDeliveryConfig` must carry the facts an external executor can actually use:

| Field | Needed because |
| --- | --- |
| `repoUrl` | a cloneable identifier. **`repoPath` is not a substitute** — it is a path on the machine the built-in agent runs on, and a remote client cannot `cd` into it |
| `defaultBranch` | what a delivery report is checked against |
| `deployDocPath` | where the site documents its own release process |
| `adapters` | which delivery lanes the site accepts |

`seo_get_execution_config` reports `canExecute: false` and names each missing fact rather
than returning a local path the caller will fail to use. Live state as of this writing: of
eight sites, none has a `repoUrl`, so none is externally executable yet — two have a
`repoPath` and six have no delivery config at all.

That is the honest current state, and it is why the tool reports `missing` instead of
guessing: the capability is built, and the configuration is unset.
