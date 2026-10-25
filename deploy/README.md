# CrawlSEO deployment

The web app, authenticated MCP endpoint, and durable job worker run as separate
PM2 processes. The web process uses immutable release slots. Build from an
isolated checkout, stage a new release, atomically move the `current` symlink,
then reload only the web process:

```bash
# In an isolated official source checkout, not /SEO while its server is live:
npm ci
npx prisma generate
npm run build

RELEASE_DIR="/SEO/.releases/web/$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
node scripts/stage-production-web.mjs \
  --source "$PWD" \
  --build-dir "$PWD/.next" \
  --release-dir "$RELEASE_DIR" \
  --env-file "/SEO/.env.local"

ln -s "$RELEASE_DIR" /SEO/.releases/web/current.next
mv -Tf /SEO/.releases/web/current.next /SEO/.releases/web/current
pm2 reload deploy/ecosystem.config.cjs --only crawlseo
pm2 save
```

The staging command requires explicit source, build, release, and runtime env
paths. It copies the standalone server, `.next/static`, and `public` into a new
release directory, copies the runtime env file as `.env` with mode `0600`,
validates the staged server and build ID, and refuses any pre-existing release
path. It does not print env contents or build with the runtime env file. The
startup script resolves the configured slot and launches `server.js` from that
directory without copying or changing release assets. If
`CRAWLSEO_WEB_RELEASE_DIR` is set but invalid, startup fails closed. If it is
unset, the old in-place startup path remains available for backwards
compatibility.

Do not run `npm run build` in `/SEO` while the web server is live: Next may
replace `.next` files while the active process is reading them. Keep old
release directories until the new slot is verified and rollback is no longer
needed. To roll back, atomically point `current` at the prior release and
reload only `crawlseo` again.

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
