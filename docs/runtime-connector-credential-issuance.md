# Runtime connector credential issuance

The internal `POST /api/internal/sites/{siteId}/runtime-connector-credentials` endpoint issues the separate credential used by HelloAda runtime connector operations. Authenticate with `Authorization: Bearer $HELLOADA_PROVISIONING_TOKEN`.

Request JSON:

```json
{
  "expectedGeneration": 4,
  "activationPlanHash": "<64-character SHA-256 hex digest>",
  "idempotencyKey": "<stable activation request key>"
}
```

The endpoint requires the site to belong to an active project and workspace, and requires an active `helloada` connector binding for that project at exactly `expectedGeneration`. It returns only `connector:read` and `connector:write` scopes. It neither changes jobs, settings, or budget, nor revokes the existing provisioning credential.

Keep the idempotency key stable for retries of one activation request and use a new key for a new activation request. The credential record binds that key to a hash of the site, generation, activation plan hash, and scopes. Reusing the key with different inputs returns a conflict. The secret is returned only when first issued; a retry identifies the existing credential without exposing its token again.

Legacy project provisioning continues to issue the original five MCP scopes (`seo:read`, `seo:research:request`, `analytics:read`, `crawl:read`, and `crawl:run`). `seo:research:request` authorizes requesting and retrieving prelaunch research; no separate `seo:research` scope exists. Runtime connector access is issued separately through this endpoint.
