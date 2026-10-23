-- Allow the same external Google resource (e.g. a shared GA4 property) to be
-- granted to more than one site, while keeping project-level grants unique.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'IntegrationGrant'
      AND indexname LIKE 'IntegrationGrant_connectionId_projectId_provider_externalResour%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX "IntegrationGrant_conn_project_provider_resource_site_null_key"
  ON "IntegrationGrant" ("connectionId", "projectId", provider, "externalResourceId")
  WHERE "siteId" IS NULL;

CREATE UNIQUE INDEX "IntegrationGrant_conn_project_provider_resource_site_key"
  ON "IntegrationGrant" ("connectionId", "projectId", provider, "externalResourceId", "siteId")
  WHERE "siteId" IS NOT NULL;

CREATE INDEX "IntegrationGrant_conn_project_provider_resource_idx"
  ON "IntegrationGrant" ("connectionId", "projectId", provider, "externalResourceId");
