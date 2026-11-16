-- ===== 1. Extensions, roles and helper functions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api')    THEN CREATE ROLE app_api    NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN CREATE ROLE app_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN CREATE ROLE app_system NOLOGIN BYPASSRLS; END IF;
END $$;

-- UUIDv7 (time-ordered). On PostgreSQL 18+ replace the body with: SELECT uuidv7();
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  RETURN encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
              FROM 1 FOR 6),
      52, 1), 53, 1), 'hex')::uuid;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Tenant context set by the application with: SET LOCAL app.org_id = '<uuid>';
CREATE OR REPLACE FUNCTION current_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP; END $$;

CREATE OR REPLACE FUNCTION create_hash_partitions(parent text, modulus int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  FOR i IN 0..modulus - 1 LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
                   parent || '_p' || lpad(i::text, 2, '0'), parent, modulus, i);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION create_range_partitions(parent text, first_day date, n int, step interval, suffix_fmt text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s date; e date;
BEGIN
  FOR i IN 0..n - 1 LOOP
    s := (first_day + step * i)::date;
    e := (first_day + step * (i + 1))::date;
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                   parent || '_' || to_char(s, suffix_fmt), parent, s, e);
  END LOOP;
END $$;

-- ===== 2. Identity and tenancy
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug        citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  plan        text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team','enterprise')),
  data_region text NOT NULL DEFAULT 'us' CHECK (data_region IN ('us','eu','in')),
  is_personal boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  email             citext NOT NULL UNIQUE,
  email_verified_at timestamptz,
  display_name      text CHECK (char_length(display_name) <= 120),
  idp_subject       text NOT NULL UNIQUE,
  locale            text NOT NULL DEFAULT 'en',
  risk_score        smallint NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  free_credits_granted_at timestamptz,      -- exactly-once guard for the signup grant
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  prefix      text NOT NULL UNIQUE,                 -- public part of sf_live_<prefix>_<secret>
  secret_hash bytea NOT NULL,                       -- SHA-256 of secret
  scopes      text[] NOT NULL CHECK (cardinality(scopes) > 0),
  last_used_at timestamptz,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ===== 3. Projects and Reference Mode evidence
CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description text CHECK (char_length(description) <= 2000),
  idea_text   text CHECK (char_length(idea_text) <= 20000),
  language    text NOT NULL DEFAULT 'en',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (org_id, id)                                -- target for composite tenant-safe FKs
);

CREATE TABLE reference_sources (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id           uuid NOT NULL,
  project_id       uuid NOT NULL,
  url              text NOT NULL CHECK (char_length(url) <= 2048 AND url ~ '^https?://'),
  host             text NOT NULL,
  status           text NOT NULL DEFAULT 'crawling'
                   CHECK (status IN ('crawling','preview_ready','auth_wall','failed','rejected','confirmed')),
  failure_code     text,
  attested_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  attested_at      timestamptz NOT NULL,
  max_pages        smallint NOT NULL DEFAULT 25 CHECK (max_pages BETWEEN 1 AND 50),
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb,
  crawl_started_at timestamptz,
  crawl_finished_at timestamptz,
  confirmed_at     timestamptz,
  reuse_until      timestamptz,                      -- cached extraction reuse window (6 h)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);

-- Partitioned monthly: about 1.5M rows per day at 1M DAU; 90-day metadata retention
CREATE TABLE crawl_pages (
  id                 uuid NOT NULL DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  source_id          uuid NOT NULL,
  url                text NOT NULL,
  url_sha256         bytea NOT NULL,
  depth              smallint NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 10),
  state              text NOT NULL CHECK (state IN ('captured','partial','skipped')),
  skip_reason        text CHECK (skip_reason IN ('ROBOTS_DISALLOWED','AUTH_REQUIRED','TIMEOUT','BLOCKED_HOST','OFF_ORIGIN','PAGE_LIMIT','TARGET_UNHEALTHY')),
  http_status        smallint,
  title              text,
  template_cluster   text,
  dom_s3_key         text,
  screenshot_s3_key  text,
  thumbnail_s3_key   text,
  content_sha256     bytea,
  a11y_summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  FOREIGN KEY (org_id, source_id) REFERENCES reference_sources(org_id, id) ON DELETE CASCADE
) PARTITION BY RANGE (created_at);

CREATE TABLE design_extractions (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id               uuid NOT NULL,
  source_id            uuid NOT NULL,
  tokens               jsonb NOT NULL DEFAULT '{}'::jsonb,
  components           jsonb NOT NULL DEFAULT '[]'::jsonb,
  information_arch     jsonb NOT NULL DEFAULT '{}'::jsonb,
  flows                jsonb NOT NULL DEFAULT '[]'::jsonb,
  tech_hints           jsonb NOT NULL DEFAULT '{}'::jsonb,
  injection_suspected  boolean NOT NULL DEFAULT false,
  schema_version       smallint NOT NULL DEFAULT 1,
  model                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id),
  FOREIGN KEY (org_id, source_id) REFERENCES reference_sources(org_id, id) ON DELETE CASCADE
);

-- ===== 4. Templates, runs and stages
CREATE TABLE templates (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,   -- NULL = global template
  doc_type     text NOT NULL CHECK (doc_type IN ('PRD','TRD','UIUX','SCHEMA','CUSTOM')),
  name         text NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  body         jsonb NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_templates_identity
  ON templates (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), doc_type, name, version);

-- Hash-partitioned by org_id (16): every query carries org_id, so each query prunes to one partition
CREATE TABLE generation_runs (
  id                  uuid NOT NULL DEFAULT uuid_v7(),
  org_id              uuid NOT NULL,
  project_id          uuid NOT NULL,
  source_id           uuid,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  mode                text NOT NULL CHECK (mode IN ('idea','reference')),
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','paused_provider','reviewed','reviewed_with_warnings','failed','cancelled')),
  input               jsonb NOT NULL DEFAULT '{}'::jsonb,
  language            text NOT NULL DEFAULT 'en',
  doc_types           text[] NOT NULL DEFAULT ARRAY['PRD','TRD','UIUX','SCHEMA'],
  glossary            jsonb NOT NULL DEFAULT '{}'::jsonb,
  credit_cost         numeric(10,2) NOT NULL CHECK (credit_cost >= 0),
  credits_reserved    numeric(10,2) NOT NULL CHECK (credits_reserved >= 0),
  credits_settled     numeric(10,2) NOT NULL DEFAULT 0 CHECK (credits_settled >= 0),
  max_input_tokens    integer NOT NULL CHECK (max_input_tokens > 0),
  max_output_tokens   integer NOT NULL CHECK (max_output_tokens > 0),
  max_repair_attempts smallint NOT NULL DEFAULT 2 CHECK (max_repair_attempts BETWEEN 0 AND 3),
  tokens_in           bigint NOT NULL DEFAULT 0,
  tokens_out          bigint NOT NULL DEFAULT 0,
  llm_calls           integer NOT NULL DEFAULT 0 CHECK (llm_calls <= 40),
  injection_suspected boolean NOT NULL DEFAULT false,
  cancel_requested_at timestamptz,
  error_code          text,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CHECK (credits_settled <= credits_reserved),
  CHECK (mode = 'idea' OR source_id IS NOT NULL),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, source_id)  REFERENCES reference_sources(org_id, id) ON DELETE SET NULL (source_id)
) PARTITION BY HASH (org_id);

CREATE TABLE run_stages (
  id               uuid NOT NULL DEFAULT uuid_v7(),
  org_id           uuid NOT NULL,
  run_id           uuid NOT NULL,
  stage            text NOT NULL CHECK (stage IN ('INTAKE_VALIDATE','CRAWL_FAST','EXTRACT','PRD','TRD','UX','SCHEMA','SCHEMA_VALIDATE','REVIEW','FINALIZE')),
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','retry_wait','succeeded','failed','skipped','cancelled')),
  attempt          smallint NOT NULL DEFAULT 0,
  lease_owner      text,
  lease_expires_at timestamptz,
  next_attempt_at  timestamptz,
  tokens_in        integer NOT NULL DEFAULT 0,
  tokens_out       integer NOT NULL DEFAULT 0,
  credits_settled  numeric(10,2) NOT NULL DEFAULT 0 CHECK (credits_settled >= 0),
  provider         text,
  model            text,
  error_code       text,
  error_detail     text,
  output_ref       jsonb NOT NULL DEFAULT '{}'::jsonb,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, run_id, stage),
  FOREIGN KEY (org_id, run_id) REFERENCES generation_runs(org_id, id) ON DELETE CASCADE
) PARTITION BY HASH (org_id);

-- ===== 5. Documents, immutable versions and searchable sections
CREATE TABLE documents (
  id                uuid NOT NULL DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL,
  run_id            uuid,
  template_id       uuid REFERENCES templates(id) ON DELETE SET NULL,
  doc_type          text NOT NULL CHECK (doc_type IN ('PRD','TRD','UIUX','SCHEMA','CUSTOM')),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  current_version_id uuid,
  latest_version_no integer NOT NULL DEFAULT 0 CHECK (latest_version_no >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, run_id)     REFERENCES generation_runs(org_id, id) ON DELETE SET NULL (run_id)
) PARTITION BY HASH (org_id);

CREATE TABLE document_versions (
  id             uuid NOT NULL DEFAULT uuid_v7(),
  org_id         uuid NOT NULL,
  document_id    uuid NOT NULL,
  version_no     integer NOT NULL CHECK (version_no >= 1),
  author_type    text NOT NULL CHECK (author_type IN ('ai','user')),
  author_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  change_note    text CHECK (char_length(change_note) <= 500),
  content_md     text NOT NULL,
  content_sha256 bytea NOT NULL,
  sections_count integer NOT NULL DEFAULT 0,
  model          text,
  tokens_in      integer NOT NULL DEFAULT 0,
  tokens_out     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),   -- immutable: no updated_at
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, document_id, version_no),
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE CASCADE
) PARTITION BY HASH (org_id);

ALTER TABLE documents
  ADD CONSTRAINT fk_documents_current_version
  FOREIGN KEY (org_id, current_version_id) REFERENCES document_versions(org_id, id)
  ON DELETE SET NULL (current_version_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE document_sections (
  id          uuid NOT NULL DEFAULT uuid_v7(),
  org_id      uuid NOT NULL,
  version_id  uuid NOT NULL,
  ordinal     integer NOT NULL CHECK (ordinal >= 0),
  anchor      text NOT NULL,
  heading     text NOT NULL,
  body_md     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'done' CHECK (status IN ('queued','generating','done','failed')),
  error_code  text,
  embedding   vector(1024),
  tsv         tsvector GENERATED ALWAYS AS
              (to_tsvector('simple'::regconfig, coalesce(heading,'') || ' ' || coalesce(body_md,''))) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, version_id, ordinal),
  FOREIGN KEY (org_id, version_id) REFERENCES document_versions(org_id, id) ON DELETE CASCADE
) PARTITION BY HASH (org_id);

-- ===== 6. Exports and sharing
CREATE TABLE exports (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id       uuid NOT NULL,
  document_id  uuid,
  run_id       uuid,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  format       text NOT NULL CHECK (format IN ('docx','pdf','md','zip')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  s3_key       text,
  size_bytes   bigint CHECK (size_bytes >= 0),
  error_code   text,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(document_id, run_id) = 1),
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id)       ON DELETE CASCADE,
  FOREIGN KEY (org_id, run_id)      REFERENCES generation_runs(org_id, id) ON DELETE CASCADE
);

CREATE TABLE share_links (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id          uuid NOT NULL,
  document_id     uuid NOT NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  token_hash      bytea NOT NULL UNIQUE,              -- SHA-256 of 256-bit random token
  password_hash   text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  view_count      integer NOT NULL DEFAULT 0,
  last_viewed_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE CASCADE
);

-- ===== 7. Idempotency, billing, credits and ledger
-- Hash-partitioned (16): high-churn table, per-partition autovacuum, batched expiry deletes
CREATE TABLE idempotency_keys (
  id              uuid NOT NULL DEFAULT uuid_v7(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idem_key        text NOT NULL CHECK (char_length(idem_key) BETWEEN 8 AND 64),
  method          text NOT NULL,
  path            text NOT NULL,
  request_hash    bytea NOT NULL,
  state           text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress','completed')),
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, idem_key)
) PARTITION BY HASH (org_id);

CREATE TABLE credit_accounts (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id     uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  balance    numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved   numeric(12,2) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved <= balance)
);

-- Append-only, monthly range partitions, 7-year financial retention (old partitions detached to cold storage).
-- run_id is a deliberate soft reference: runs are archived at 13 months, the ledger must outlive them.
-- Exactly-once is guaranteed by the owning transaction (run_stages conditional status transition, users.free_credits_granted_at,
-- webhook_events unique event id), not by a unique key here, because a unique key on a time-partitioned table must include created_at.
CREATE TABLE usage_ledger (
  id            uuid NOT NULL DEFAULT uuid_v7(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  entry_type    text NOT NULL CHECK (entry_type IN ('grant','purchase','reserve','settle','release','refund','expire','adjust')),
  amount        numeric(12,2) NOT NULL CHECK (amount >= 0),
  run_id        uuid,
  stage         text,
  ledger_key    text NOT NULL,
  balance_after numeric(12,2) NOT NULL,
  reserved_after numeric(12,2) NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                 uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  stripe_customer_id     text NOT NULL UNIQUE,
  stripe_subscription_id text UNIQUE,
  plan                   text NOT NULL CHECK (plan IN ('free','pro','team','enterprise')),
  status                 text NOT NULL CHECK (status IN ('active','trialing','past_due','canceled','incomplete')),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  last_event_at          timestamptz NOT NULL DEFAULT 'epoch',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  provider          text NOT NULL CHECK (provider IN ('stripe','idp')),
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  attempts          smallint NOT NULL DEFAULT 0,
  error             text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (provider, provider_event_id)
);

-- ===== 8. Outbox, audit and failed jobs
-- Daily partitions, dropped after 7 days (published) - table stays small and the relay scan stays fast
CREATE TABLE outbox_events (
  id             uuid NOT NULL DEFAULT uuid_v7(),
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  trace_context  text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','dead')),
  attempts       smallint NOT NULL DEFAULT 0,
  available_at   timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Immutable, monthly partitions, 400-day hot retention then archived to S3
CREATE TABLE audit_logs (
  id            uuid NOT NULL DEFAULT uuid_v7(),
  org_id        uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   uuid,
  ip            inet,
  user_agent    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE failed_jobs (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id           uuid REFERENCES organizations(id) ON DELETE CASCADE,
  queue            text NOT NULL,
  message_id       text NOT NULL,
  run_id           uuid,
  stage            text,
  error            text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  receive_count    smallint NOT NULL DEFAULT 1,
  first_failed_at  timestamptz NOT NULL DEFAULT now(),
  redriven_at      timestamptz,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue, message_id)
);

-- ===== 9. Indexes mapped to hot query patterns
-- Q1  Project list (keyset pagination, newest first)
CREATE INDEX ix_projects_list ON projects (org_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
-- Q2  Project name search (trigram)
CREATE INDEX ix_projects_name_trgm ON projects USING gin (name gin_trgm_ops);
-- Q3  "My organizations" at login
CREATE INDEX ix_memberships_user ON memberships (user_id, org_id);
-- Q4  API key authentication by prefix is served by the UNIQUE index on prefix; active keys listing:
CREATE INDEX ix_api_keys_org_active ON api_keys (org_id, created_at DESC) WHERE revoked_at IS NULL;
-- Q5  Sources of a project; per-host rate limit and dedupe; stuck-crawl reaper
CREATE INDEX ix_sources_project ON reference_sources (org_id, project_id, created_at DESC);
CREATE INDEX ix_sources_host_recent ON reference_sources (org_id, host, created_at DESC);
CREATE INDEX ix_sources_crawling ON reference_sources (crawl_started_at) WHERE status = 'crawling';
-- Q6  Preview page grid; one row per URL per source
CREATE INDEX ix_crawl_pages_source ON crawl_pages (org_id, source_id, state, created_at);
CREATE UNIQUE INDEX uq_crawl_pages_source_url ON crawl_pages (source_id, url_sha256, created_at);
-- Q7  Runs of a project (keyset)
CREATE INDEX ix_runs_project ON generation_runs (org_id, project_id, created_at DESC, id DESC);
-- Q8  Concurrency limiter and active-run dashboard (hot, tiny partial index)
CREATE INDEX ix_runs_active ON generation_runs (org_id, status) WHERE status IN ('queued','running','paused_provider');
-- Q9  Reaper for runs without progress (system role, cross-tenant)
CREATE INDEX ix_runs_stalled ON generation_runs (updated_at) WHERE status IN ('queued','running','paused_provider');
-- Q10 Stage lease reaper and retry scheduler
CREATE INDEX ix_stages_lease ON run_stages (lease_expires_at) WHERE status = 'running';
CREATE INDEX ix_stages_retry ON run_stages (next_attempt_at) WHERE status = 'retry_wait';
-- Q11 Documents in a project, by type
CREATE INDEX ix_documents_project ON documents (org_id, project_id, doc_type, updated_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_documents_run_type ON documents (org_id, run_id, doc_type) WHERE run_id IS NOT NULL AND deleted_at IS NULL;
-- Q12 Version history (list newest first); exact version is served by UNIQUE (org_id, document_id, version_no)
CREATE INDEX ix_versions_doc ON document_versions (org_id, document_id, version_no DESC);
-- Q13 Full-text and semantic search within an organization (partition pruned by org_id)
CREATE INDEX ix_sections_tsv ON document_sections USING gin (tsv);
CREATE INDEX ix_sections_embedding ON document_sections USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
-- Q14 Export status polling and worker pickup
CREATE INDEX ix_exports_doc ON exports (org_id, document_id, created_at DESC);
CREATE INDEX ix_exports_pending ON exports (created_at) WHERE status IN ('queued','running');
-- Q15 Share link management (public lookup uses UNIQUE token_hash)
CREATE INDEX ix_share_links_doc ON share_links (org_id, document_id) WHERE revoked_at IS NULL;
-- Q16 Idempotency expiry sweep (batched deletes)
CREATE INDEX ix_idem_expiry ON idempotency_keys (expires_at);
-- Q17 Ledger statements per organization and per run
CREATE INDEX ix_ledger_org_time ON usage_ledger (org_id, created_at DESC);
CREATE INDEX ix_ledger_run ON usage_ledger (org_id, run_id, created_at) WHERE run_id IS NOT NULL;
-- Q18 Webhook reconciler picks unprocessed events
CREATE INDEX ix_webhooks_pending ON webhook_events (received_at) WHERE status IN ('received','failed');
-- Q19 Outbox relay (FOR UPDATE SKIP LOCKED scan) and dead-letter watch
CREATE INDEX ix_outbox_pending ON outbox_events (available_at, id) WHERE status = 'pending';
CREATE INDEX ix_outbox_dead ON outbox_events (created_at) WHERE status = 'dead';
-- Q20 Audit queries by org, actor and resource; BRIN for time-range exports
CREATE INDEX ix_audit_org_time ON audit_logs (org_id, created_at DESC);
CREATE INDEX ix_audit_actor ON audit_logs (org_id, actor_user_id, created_at DESC);
CREATE INDEX ix_audit_resource ON audit_logs (org_id, resource_type, resource_id, created_at DESC);
CREATE INDEX ix_audit_brin ON audit_logs USING brin (created_at);
-- Q21 Failed job triage
CREATE INDEX ix_failed_jobs_open ON failed_jobs (queue, first_failed_at) WHERE resolved_at IS NULL;
-- Q22 Subscription lookups from Stripe ids are served by UNIQUE indexes on stripe_customer_id and stripe_subscription_id

-- ===== 10. Partitions
SELECT create_hash_partitions('generation_runs',  16);
SELECT create_hash_partitions('run_stages',       16);
SELECT create_hash_partitions('documents',        16);
SELECT create_hash_partitions('document_versions',16);
SELECT create_hash_partitions('document_sections',16);
SELECT create_hash_partitions('idempotency_keys', 16);
-- Monthly range partitions: create 12 months ahead; a scheduled job (pg_partman or a cron Lambda) keeps 3+ months ahead
SELECT create_range_partitions('crawl_pages',  date '2026-11-01', 12, interval '1 month', 'YYYY_MM');
SELECT create_range_partitions('usage_ledger', date '2026-11-01', 12, interval '1 month', 'YYYY_MM');
SELECT create_range_partitions('audit_logs',   date '2026-11-01', 12, interval '1 month', 'YYYY_MM');
-- Daily partitions for the outbox: create 14 days ahead
SELECT create_range_partitions('outbox_events', date '2026-11-13', 14, interval '1 day', 'YYYY_MM_DD');

-- ===== 11. Triggers: updated_at, immutability
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','users','memberships','api_keys','projects','reference_sources',
    'design_extractions','templates','generation_runs','run_stages','documents','document_sections','exports',
    'share_links','credit_accounts','subscriptions','failed_jobs'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

CREATE TRIGGER trg_versions_immutable BEFORE UPDATE ON document_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_audit_immutable_u BEFORE UPDATE ON audit_logs  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_audit_immutable_d BEFORE DELETE ON audit_logs  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_ledger_immutable_u BEFORE UPDATE ON usage_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_ledger_immutable_d BEFORE DELETE ON usage_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ===== 12. Row-Level Security (tenant isolation, enforced even if application code has a bug)
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','api_keys','projects','reference_sources','crawl_pages','design_extractions',
    'generation_runs','run_stages','documents','document_versions','document_sections','exports','share_links',
    'idempotency_keys','credit_accounts','usage_ledger','subscriptions','failed_jobs','outbox_events','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_org()) WITH CHECK (org_id = current_org())', t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (id = current_org()) WITH CHECK (id = current_org());

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;
CREATE POLICY templates_read  ON templates FOR SELECT USING (org_id IS NULL OR org_id = current_org());
CREATE POLICY templates_write ON templates FOR ALL    USING (org_id = current_org()) WITH CHECK (org_id = current_org());

-- users and webhook_events are not tenant-scoped; they are reachable only through the app_system role and
-- through SECURITY DEFINER lookups (login, webhook ingestion).

-- ===== 13. Grants (least privilege)
GRANT USAGE ON SCHEMA public TO app_api, app_worker, app_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_api, app_worker, app_system;
REVOKE UPDATE, DELETE ON audit_logs, usage_ledger FROM app_api, app_worker, app_system;
REVOKE DELETE ON document_versions FROM app_api, app_worker;
REVOKE ALL ON webhook_events, users FROM app_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_api, app_worker, app_system;
-- Partitions are never queried directly; privileges are granted on parents only. Revoke them on children:
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid WHERE c.relkind = 'r' LOOP
    EXECUTE format('REVOKE ALL ON %I FROM app_api, app_worker', r.relname);
  END LOOP;
END $$;
