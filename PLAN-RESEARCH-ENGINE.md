# PLAN: CrawlSEO Research, Work, and Wix Delivery

> Status: revised implementation plan
> Date: 2026-10-23
> Supersedes the earlier research-engine plan in this file.

## 1. Objective

Make CrawlSEO the central system for:

1. Autonomous research.
2. Evidence-backed Actions.
3. Content creation.
4. Agent-assisted implementation.
5. Wix embed and blog delivery.
6. Human review, approval, and outcome tracking.

The human configures the site and makes decisions. The AI does the research, proposes work, drafts content, implements approved changes, and prepares delivery.

## 2. Product principles

1. **AI does research.** Humans do not write per-run research prompts during normal use.
2. **Human guidance is configuration.** Topics, audience, markets, exclusions, budgets, cadence, and automation are site settings.
3. **One Work area.** Research, content, implementation, and delivery are views of one Action workflow, not separate products.
4. **Action is the unit of work.** Every change has evidence, status, owner, content, delivery, and outcome.
5. **AI may edit code.** It works in a clean worktree with a constrained task prompt and no production credentials.
6. **Human approves.** Agent work is reviewed before commit, apply, or publish.
7. **Bridge is the Wix delivery interface.** CrawlSEO does not know bridge credential files or internal state paths.
8. **Blogs and embeds use different adapters.** Wix Blog is not the Custom Embeds bridge.
9. **Wix CMS is out of scope for this pipeline.**
10. **Commit before publish for code changes.** The bridge must deploy a known commit.
11. **No per-app research prompt stacks.** Apps call CrawlSEO; CrawlSEO shares research and actions.
12. **Keep the implementation lean.** Prefer agentic execution over encoding every possible page edit in a schema.

## 3. Revised product structure

```text
Site
  Work
    Inbox
    Actions
    Drafts
    Agent tasks
    Delivery

  Research
    Runs
    Findings
    Sources

  Settings
    Research configuration
    Automation policy
    Integrations
    Delivery targets
```

### Work → Inbox

The primary daily screen.

Shows:

- proposed Actions
- Actions awaiting approval
- drafts awaiting review
- agent tasks awaiting review
- deliveries awaiting verification
- failures and blocked tasks

### Work → Actions

All persisted Actions, regardless of source:

- GSC opportunity
- crawl issue
- keyword research
- market research
- manual request

### Work → Drafts

Content drafts linked to Actions.

Content Studio becomes a draft workspace, not a separate queue.

### Work → Agent tasks

Implementation tasks with:

- task-scoped AI chat
- diff
- build/test result
- bridge plan
- approval, commit, publish, verify, close

### Work → Delivery

- Wix Blog drafts/posts
- Wix embed releases
- receipts
- published URLs
- verification

### Research

Autonomous research feed:

- scheduled runs
- findings
- sources
- exclusions
- unresolved contradictions

Manual “Create research run” moves to an advanced/debug action. It is not the primary workflow.

### Settings → Research configuration

```text
topics
audience
markets
business goals
priority services
competitors
allowed source providers
excluded sources/topics
recency window
research cadence
monthly budget
automation mode
```

## 4. Research behavior

### Automatic scheduling

- Daily/weekly light market scan.
- Monthly deep research.
- New signal-triggered research when GSC/crawl/keyword data changes materially.
- On-demand API/MCP research for other apps.
- A manual “Run now” button in advanced settings.

### Research pipeline

```text
site configuration
  → AI query/source planning
  → Reddit/news/web retrieval
  → evidence storage
  → claim-type validation
  → findings
  → Action candidates
  → dedupe/merge into Work queue
```

The human does not select subreddits or write queries. The AI does that from the site configuration.

### Research sources

- Reddit: interim RSS, then read-only OAuth bot
- Google News / approved news API
- web search provider
- first-party GSC/GA4/crawl
- DataForSEO for keyword/SERP/backlink evidence

## 5. Action model

An Action combines evidence from multiple sources.

```text
Action
  siteId
  source
  kind
  format
  targetUrl / query / topic
  recommendation
  evidence JSON
  priority
  status
  automationMode
  dedupeKey
  contentDrafts
  agentTasks
  deliveries
```

### Status

```text
PROPOSED
APPROVED
DISMISSED
DRAFTING
DRAFT_READY
DELIVERY_APPROVED
DELIVERING
DELIVERED
VERIFIED
FAILED
```

### Source types

- `market_research`
- `keyword_research`
- `seo_opportunity`
- `crawl_issue`
- `manual`

### Merge rules

- Same target page + query/topic merges into one Action.
- Market research without demand can still create an Action with lower priority.
- Keyword demand without audience insight can create an Action, but content is weaker.
- Existing pages are preferred for page updates.
- New articles are preferred when no page satisfies the intent.
- Preserve all evidence, not only the winning signal.

## 6. Action detail page

Create one URL:

```text
/sites/:siteId/actions/:actionId
```

It contains:

- evidence and findings
- keyword/GSC demand
- recommendation and priority
- content draft
- agent task and AI chat
- delivery/publish state
- audit history

No cross-links between separate “Research” and “Content Studio” queues.

## 7. Agent implementation loop

### States

```text
READY
  → RUNNING
  → AWAITING_REVIEW
  → CHANGES_REQUESTED
  → RUNNING
  → APPROVED
  → COMMITTED
  → PUBLISHING
  → PUBLISHED
  → CLOSED
```

Failure states:

```text
FAILED
CANCELLED
```

### Chat

Each AgentTask has a task-scoped chat:

- human messages
- agent messages
- system events
- tool events
- diff cards
- build/test results
- bridge plan
- delivery receipt

Use an OpenCode/OpenChamber session per task. Continue the same session for corrections.

### Execution

The worker:

1. Creates a clean worktree from the connected site repository.
2. Spawns the coding agent with the task prompt.
3. Agent edits code/content and runs lint/build/tests.
4. Agent runs bridge `inspect` and `plan` only.
5. Worker captures diff, test output, and bridge plan.
6. Human reviews and can reply with corrections.
7. Human approves.
8. Agent commits/pushes the branch.
9. Human merges or authorizes the connected main branch.
10. Bridge applies/publishes.
11. Human verifies.
12. Human closes the task.
13. AI records final commit, receipt, and delivery status.

### Guardrails

The agent:

- never receives Wix app secrets or API keys
- never runs `wix publish`
- never runs bridge `apply`/`release`
- never pushes to main without approval
- works only in the task worktree
- must produce a diff and verification output

## 8. Wix delivery architecture

Two adapters, one site delivery configuration.

```text
SiteDeliveryConfig
  siteId
  bridgeAlias
  adapters: ["wix_embed", "wix_blog"]
  enabled
```

CrawlSEO stores only the bridge alias and adapter names. It does not store bridge credentials, manifests, state directories, or translation file paths.

### Primitive bridge interface

The bridge becomes a stable JSON service:

```bash
bridge site inspect --site susimacdonald --json
bridge site plan --site susimacdonald --plan task.json --json
bridge site apply --site susimacdonald --plan task.json --apply --json
bridge site verify --site susimacdonald --receipt receipt.json --json
```

The bridge owns:

- `sites/<alias>/.wix-bridge-state/app.env`
- `sites/<alias>/site.manifest.json`
- translation routes/groups
- state, snapshots, backups, receipts
- `WIX_ALLOWED_SITE_IDS`

`inspect` returns:

- site identity
- connected repo and branch
- adapters
- routes/components
- custom code inventory
- delivery capabilities

`plan` returns:

- target adapter
- target route/section
- file/snippet changes
- whether a site publish is required
- dry-run diff
- rollback plan

`apply` returns:

- bridge receipt ID
- applied snippet/release state
- recovery information
- verification requirements

### Bridge manifest additions

Add a delivery map:

```json
{
  "routes": [
    {
      "route": "/apartments-for-rent-in-playa",
      "component": "rental-faq-v1",
      "source": "src/public/custom-elements/rental-faq-v1.js",
      "snippetId": "...",
      "adapter": "wix_embed",
      "requiresSitePublish": false
    }
  ]
}
```

- `wix_embed`: bridge-managed page section
- `wix_blog`: separate Wix Blog API
- `manual`: no supported automated path

### Wix Blog adapter

Use the existing Susi Wix Blog API adapter.

- Create Wix Blog draft.
- Update existing post with fingerprint guard.
- Verify draft/post readback.
- Human publishes in Wix.
- Store post/draft ID, URL, status.

Blog credentials remain separate:

```text
WIX_API_KEY
WIX_SITE_ID
```

### Wix embed adapter

- Resolve route/component from the bridge delivery map.
- Apply content/code changes through the bridge.
- Preserve English/Spanish behavior.
- Snapshot before apply.
- Verify snippet hash/readback.
- Human publishes code when required.

### Out of scope

- Wix CMS/Data collection updates
- native Wix page layout/text/SEO edits without a supported adapter

## 9. Data model additions

Existing models remain:

- `SiteProfile`
- `ResearchRun`
- `ResearchSource`
- `ResearchFinding`
- `ResearchAction`
- `ContentDraft`
- `AgentTask`
- `Delivery`

Add:

- `ResearchPolicy` — cadence, budgets, providers, automation mode
- `AgentTaskMessage` — human/agent/system chat
- `AgentTaskArtifact` — diff, build, test, bridge plan, receipt
- `SiteDeliveryConfig` — bridge alias and adapters
- `DeliveryTarget` — optional cached bridge route/component map

`AgentTask` adds:

```text
opencodeSessionId
status
branch
worktreePath
commitSha
bridgeReceiptId
publishedUrl
closedAt
```

## 10. API and MCP

API:

```text
GET/POST /api/sites/:siteId/research/config
GET      /api/sites/:siteId/research/runs
GET      /api/sites/:siteId/actions
GET      /api/actions/:actionId
POST     /api/actions/:actionId/approve
POST     /api/actions/:actionId/agent-task
GET      /api/agent-tasks/:taskId
POST     /api/agent-tasks/:taskId/messages
POST     /api/agent-tasks/:taskId/run
POST     /api/agent-tasks/:taskId/approve
POST     /api/agent-tasks/:taskId/commit
POST     /api/agent-tasks/:taskId/publish
POST     /api/agent-tasks/:taskId/close
GET/POST /api/sites/:siteId/delivery
```

MCP equivalents:

```text
get_research_config
list_research_runs
list_actions
get_action
create_agent_task
send_agent_message
approve_agent_task
publish_delivery
get_delivery_status
```

## 11. UI changes

Remove or demote:

- “New research run / Ask the engine” as primary UI
- Research → Content Studio link
- separate Content Studio action queue

Keep:

- Content Studio as a draft editor/detail view
- existing APIs for compatibility
- “Run now” in advanced/debug settings

Add:

- Work → Inbox
- Action detail page
- task-scoped AI chat
- diff/build/bridge-plan cards
- delivery plan and approval
- research configuration
- bridge connection status

## 12. Rollout

### Phase A — Product consolidation

- Add Work area and Inbox.
- Add Action detail page.
- Move manual research creation to advanced.
- Make Content Studio consume persisted Actions/drafts.
- Remove duplicate action queues and cross-links.

### Phase B — Autonomous research

- Add ResearchPolicy configuration.
- Schedule light/deep research.
- Add signal-triggered runs.
- Remove per-run prompt form from primary UI.

### Phase C — Agent review loop

- Add AgentTask messages/artifacts.
- Integrate OpenCode sessions and worktrees.
- Add chat, corrections, approve, commit.

### Phase D — Bridge interface

- Add `bridge site inspect/plan/apply/verify --json`.
- Add `SiteDeliveryConfig`.
- Populate Susi route/component delivery map.
- Add Wix embed adapter.

### Phase E — Wix Blog

- Add Wix Blog draft/update adapter.
- Add human publish and readback verification.

### Phase F — Outcomes

- Record published URLs and receipts.
- Measure GSC/GA4 outcomes.
- Use outcomes to adjust action priority and automation policy.

## 13. Acceptance criteria

- Human configures research once; scheduled runs happen without per-run prompts.
- Work Queue shows every Action from every source in one place.
- Action detail contains evidence, draft, agent task, chat, and delivery.
- AI agent can edit code in a clean worktree and request review.
- Human can reply with corrections in the task chat.
- Human can approve, commit, publish, verify, and close.
- AI records commit and bridge receipt.
- CrawlSEO never handles bridge credentials directly.
- Bridge is called only by site alias through a stable JSON interface.
- Wix Blog and Wix embeds use separate adapters.
- Wix CMS is not part of this pipeline.
- No automatic publish without explicit approval.

## 14. Current implementation status

Implemented:

- Research/action/content database foundation
- Reddit RSS and Google News RSS providers
- AI research synthesis into findings and Actions
- SEO opportunity persistence
- Keyword evidence merge
- Content Studio draft generation from Actions
- AgentTask handoff with prompt and guardrails
- Wix Blog target detection
- Agent task APIs/UI
- unified Work page with Inbox, Actions, Drafts, and Agent tasks
- Action detail page with evidence, drafts, agent tasks, and task-scoped chat
- `ResearchPolicy` configuration UI and API
- autonomous scheduled research script and cron
- `SiteDeliveryConfig` model and Susi bridge alias/adapters
- navigation consolidation removing separate Opportunities/Content Studio entries
- manual research form removed from the primary Research page
- OpenCode worktree runner with durable `AGENT_TASK` jobs
- agent run artifacts (diff/git status), chat message, and `AWAITING_REVIEW` state
- Wix Blog draft adapter with rich-content conversion, category/tag/member resolution, slug checks, and readback verification
- bridge inspect client and delivery status UI
- live Wix Blog draft created for Susi and verified as unpublished
- agent task review transitions, local commit with SHA, publish record, and close
- bridge plan API/UI and plan artifact storage
- DeliveryTarget model and Susi component/snippet inventory
- live-synced Susi manifest page scopes and load settings
- bridge `--preserve-scope` content packet updates
- Wix embed packet rebuilding that preserves multi-component packets
- embed plan/apply controls with explicit confirmation
- live-tested Wix Blog draft creation, agent worktree execution, local commit, publish-record, and close transitions

Still pending:

- live embed apply verification on a non-critical Susi section
- post-delivery GSC/GA4 outcome tracking

## 15. Immediate next implementation

1. Add review/approve/commit/publish/close transitions and artifacts.
2. Add bridge `site plan/apply/verify --json` UI workflow.
3. Populate Susi route/component delivery map.
4. Add Wix embed delivery adapter.
5. Add post-delivery verification and outcome tracking.
