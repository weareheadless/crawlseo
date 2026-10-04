# CrawlSEO deployment

The web app, authenticated MCP endpoint, and durable job worker run as separate
PM2 processes. Build first, then start or reload the checked-in ecosystem:

```bash
npm run build
pm2 startOrReload deploy/ecosystem.config.cjs
pm2 save
```

Required environment values include `DATABASE_URL`, `CREDENTIAL_ENCRYPTION_KEY`,
and the existing application/auth configuration. For zero-touch DataForSEO
project provisioning, also set `CRAWLSEO_DATAFORSEO_LOGIN` and
`CRAWLSEO_DATAFORSEO_PASSWORD` from the account's API Access page; the
authenticated HelloAda provisioning endpoint fails closed if neither these
variables nor a legacy operator key is available. The MCP process listens only on
`127.0.0.1:3006` in this deployment (ports `3004` and `3005` are used by other
local services); Nginx publishes it at `/mcp` and forwards the bearer header.

## Google project provisioning

The same service-account JSON can authenticate GA4 directly, but Google Search
Console does not accept an IAM service-account address as a property user. For a
project-scoped service-account connection, create a real Google Workspace user,
add that user to the GSC property, and authorize the service account for domain-
wide delegation with these scopes:

```text
https://www.googleapis.com/auth/webmasters.readonly
```

Set `CRAWLSEO_GOOGLE_IMPERSONATED_USER_EMAIL` to that Workspace user's email
when running `npm run provision:oceanicvibes`. The service account impersonates
that user for GSC requests. GA4 continues to use the service account directly,
so grant the service-account email Viewer access to the GA4 property.

Directly adding an address ending in `iam.gserviceaccount.com` in Search Console
will fail with `email not found`; that is expected Google behavior.

For an existing personal Google account, such as a Gmail account, set
`CRAWLSEO_GOOGLE_OAUTH_USER_EMAIL` instead. The user must already exist in the
CrawlSEO database with a stored Google OAuth refresh token and have access to the
GSC and GA4 resources. This OAuth-only mode needs no Workspace delegation or
service-account JSON.

Before the MCP process accepts traffic, configure the remote provisioning secret
(`HELLOADA_PROVISIONING_TOKEN`) only if the internal provisioning endpoint is
enabled. Do not put service credentials, Google JSON, or generated tokens in this
file or in the repository.

The worker claims PostgreSQL jobs with leases. Run exactly one PM2 worker unless
you intentionally want multiple workers; row locking supports multiple workers
when capacity requires it.
