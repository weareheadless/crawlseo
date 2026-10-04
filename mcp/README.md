# CrawlSEO MCP Servers

The local administrative MCP server exposes the legacy site tools over stdio.
The production server is a separate authenticated, project-scoped Streamable
HTTP process for site agents.

## Setup

### 1. Install tsx (if not already installed)

```bash
npm install -D tsx
```

### 2. Connect to Claude Code (local administration only)

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "crawlseo": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/path/to/crawlseo"
    }
  }
}
```

Replace `/path/to/crawlseo` with the absolute path to your project root.

### 3. Ensure DATABASE_URL is set

The server needs access to the same PostgreSQL database as the main app. Make sure your `.env` file contains `DATABASE_URL`.

Never publish `mcp/server.ts` to a network listener. It is intentionally
unscoped and accepts site IDs for local administrative use.

## Production Streamable HTTP

Start the authenticated process with:

```bash
npm run mcp:http
```

It listens on `MCP_HTTP_HOST`/`MCP_HTTP_PORT` (defaults to
`127.0.0.1:3004`) and serves `/mcp`. Every request requires a CrawlSEO service
credential. The remote tool set is fixed and resolves the project from the
credential; callers cannot select arbitrary site IDs:

| Tool | Scope | Description |
|------|-------|-------------|
| `seo_get_project` | `seo:read` | Project, site, and integration status |
| `seo_get_search_summary` | `seo:read` | Search Console query summary |
| `seo_get_analytics_summary` | `analytics:read` | Normalized GA4 weekly summary |
| `seo_request_research_report` | `seo:research:request` | Request Ada's fixed monthly batch; competitor tasks are conditional |
| `seo_get_research_report_status` | `seo:read` | Check a requested research batch |
| `seo_get_research_report` | `seo:read` | Read an immutable research report |
| `seo_get_latest_research_report` | `seo:read` | Read the latest completed research report |
| `seo_list_research_reports` | `seo:read` | List historical research reports |
| `seo_get_dataforseo_domain_report` | `seo:read` | Read the latest persisted DataForSEO domain result |
| `seo_get_dataforseo_keyword_report` | `seo:read` | Read persisted keyword ideas from the latest report |
| `seo_request_article_keyword_research` | `seo:research:request` | Reserve one exact keyword-overview task for Ada's 5-10 candidate queries |
| `seo_request_article_serp_research` | `seo:research:request` | Reserve one organic SERP snapshot for the query Ada selected |
| `seo_get_article_keyword_research_status` | `seo:read` | Check one article overview/SERP research run |
| `seo_get_article_keyword_research` | `seo:read` | Read one bounded normalized article overview/SERP result |
| `seo_list_article_keyword_research` | `seo:read` | List historical article research runs |
| `seo_get_crawl_summary` | `crawl:read` | Latest technical crawl |
| `seo_get_crawl_issues` | `crawl:read` | Latest crawl issues |
| `seo_run_crawl` | `crawl:run` | Queue a durable technical crawl |

Use `deploy/ecosystem.config.cjs` and the Nginx example for the production
processes. The checked-in deployment uses port `3006` because `3004` and `3005`
are already occupied on the HelloAda host.

### DataForSEO MCP smoke test

The opt-in smoke test connects through MCP and confirms that a persisted keyword
report can be read without starting a paid provider task. It never prints the
service token. A monthly report must already have been requested by Ada:

```bash
CRAWLSEO_SERVICE_TOKEN_FILE=/secure/path/site-agent.env \
CRAWLSEO_MCP_URL=http://127.0.0.1:3006/mcp \
npm run test:dataforseo:mcp
```

To test another seed:

```bash
CRAWLSEO_DATAFORSEO_SEED="content marketing" \
CRAWLSEO_SERVICE_TOKEN_FILE=/secure/path/site-agent.env \
CRAWLSEO_MCP_URL=http://127.0.0.1:3006/mcp \
npm run test:dataforseo:mcp
```

The test passes when `ok` is `true` and the cached report tool is available. An
empty keyword array means that the requested seed is not in the latest report;
it does not trigger a paid fallback.

### Platform-managed DataForSEO

For automatic HelloAda project provisioning, set these server-side variables:

```bash
CRAWLSEO_DATAFORSEO_LOGIN=your-dataforseo-api-login
CRAWLSEO_DATAFORSEO_PASSWORD=your-dataforseo-api-password
```

Provisioning encrypts the account credential once and grants it explicitly to
the internal CrawlSEO project. DataForSEO uses account-level credentials and
does not document REST project/subaccount creation, so customer isolation is
enforced by the CrawlSEO project, research-run, task, and report boundaries.
The authenticated HelloAda provisioning endpoint requires this platform
credential (or an explicitly supplied legacy operator BYOK key); lower-level
manual callers may still use user BYOK keys as a fallback.

## Local Administrative Tools

| Tool | Description |
|------|-------------|
| `list_sites` | List all monitored sites with basic info |
| `get_site_overview` | Site KPIs, health score, latest crawl, and vitals |
| `get_keywords` | Top keywords by clicks with position and CTR |
| `get_pages` | Top pages by clicks with position and CTR |
| `get_traffic` | Daily clicks and impressions over time |
| `run_crawl` | Start a background site crawl |
| `get_crawl_status` | Check crawl progress and results |
| `get_crawl_issues` | List issues found during a crawl |
| `get_vitals` | Core Web Vitals reports (LCP, CLS, INP, TTFB) |
| `get_opportunities` | SEO opportunities: striking distance, low CTR, content decay, cannibalization |

## Running Manually

```bash
npx tsx mcp/server.ts
```

The server communicates over stdin/stdout using the MCP protocol. Logs go to stderr.
