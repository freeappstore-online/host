-- Path B subdomain routing: maps a host (slug.zone) to an R2 prefix.
--
-- Replaces the per-app CF Pages project + per-app DNS CNAME model with a
-- single Worker (freeappstore-host) that resolves the Host header through
-- this table and streams the response from the fas-apps R2 bucket.
--
-- `hosted_on` is forward-compatible: future Pro apps may move to Workers
-- for Platforms (`hosted_on = 'wfp'`); the host worker selects only rows
-- where hosted_on = 'r2' for now.

CREATE TABLE IF NOT EXISTS routes (
  slug TEXT NOT NULL,
  zone TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  store TEXT NOT NULL,
  hosted_on TEXT NOT NULL DEFAULT 'r2',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, zone)
);

CREATE INDEX IF NOT EXISTS idx_routes_store ON routes(store);
CREATE INDEX IF NOT EXISTS idx_routes_hosted_on ON routes(hosted_on);
