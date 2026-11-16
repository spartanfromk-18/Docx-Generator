/** Domain types mirroring scripts/init_db.sql (camelCase application view of the rows). */

export type Role = "owner" | "admin" | "editor" | "viewer";
export type Plan = "free" | "pro" | "team" | "enterprise";
export type RunStatus =
  | "queued"
  | "running"
  | "paused_provider"
  | "reviewed"
  | "reviewed_with_warnings"
  | "failed"
  | "cancelled";
export type StageName =
  | "INTAKE_VALIDATE"
  | "CRAWL_FAST"
  | "EXTRACT"
  | "PRD"
  | "TRD"
  | "UX"
  | "SCHEMA"
  | "SCHEMA_VALIDATE"
  | "REVIEW"
  | "FINALIZE";
export type StageStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";
export type DocType = "PRD" | "TRD" | "UIUX" | "SCHEMA" | "CUSTOM";
export type RunMode = "idea" | "reference";
export type SourceStatus =
  | "crawling"
  | "preview_ready"
  | "auth_wall"
  | "failed"
  | "rejected"
  | "confirmed";
export type SkipReason =
  | "ROBOTS_DISALLOWED"
  | "AUTH_REQUIRED"
  | "TIMEOUT"
  | "BLOCKED_HOST"
  | "OFF_ORIGIN"
  | "PAGE_LIMIT"
  | "TARGET_UNHEALTHY";
export type LedgerEntryType =
  | "grant"
  | "purchase"
  | "reserve"
  | "settle"
  | "release"
  | "refund"
  | "expire"
  | "adjust";

export interface UserRow {
  id: string;
  email: string;
  email_verified_at: string | null;
  display_name: string | null;
  idp_subject: string;
  locale: string;
  risk_score: number;
  free_credits_granted_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  data_region: string;
  is_personal: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MembershipRow {
  id: string;
  org_id: string;
  user_id: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyRow {
  id: string;
  org_id: string;
  created_by: string | null;
  name: string;
  prefix: string;
  secret_hash: string; // sha256 hex of the secret part
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  org_id: string;
  created_by: string | null;
  name: string;
  description: string | null;
  idea_text: string | null;
  language: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CrawlPageRow {
  id: string;
  org_id: string;
  source_id: string;
  url: string;
  url_sha256: string;
  depth: number;
  state: "captured" | "partial" | "skipped";
  skip_reason: SkipReason | null;
  http_status: number | null;
  title: string | null;
  template_cluster: string | null;
  dom_s3_key: string | null;
  thumbnail_s3_key: string | null;
  content_sha256: string | null;
  a11y_summary: Record<string, unknown>;
  created_at: string;
}

export interface SourceRow {
  id: string;
  org_id: string;
  project_id: string;
  url: string;
  host: string;
  status: SourceStatus;
  failure_code: string | null;
  attested_by: string | null;
  attested_at: string;
  max_pages: number;
  stats: Record<string, unknown>;
  crawl_started_at: string | null;
  crawl_finished_at: string | null;
  confirmed_at: string | null;
  reuse_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesignExtractionRow {
  id: string;
  org_id: string;
  source_id: string;
  tokens: {
    palette?: { hex: string; role: string; usage_share: number }[];
    fonts?: { family: string; weights: number[]; usage_share: number }[];
  };
  components: { name: string; observed_from: string; confidence: "observed" | "inferred" | "assumed" }[];
  information_arch: { navigation?: { label: string; href: string; depth: number }[] };
  flows: { name: string; steps: string[] }[];
  tech_hints: Record<string, unknown>;
  injection_suspected: boolean;
  schema_version: number;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  org_id: string;
  project_id: string;
  source_id: string | null;
  created_by: string | null;
  mode: RunMode;
  status: RunStatus;
  input: {
    idea?: string;
    redacted_idea?: string;
    intake?: Record<string, string>;
    redactions?: { type: string; count: number }[];
    documents?: DocType[];
  };
  language: string;
  doc_types: DocType[];
  glossary: { canonical: Record<string, string>; entities: { name: string; definition: string }[] };
  credit_cost: number;
  credits_reserved: number;
  credits_settled: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_repair_attempts: number;
  tokens_in: number;
  tokens_out: number;
  llm_calls: number;
  injection_suspected: boolean;
  cancel_requested_at: string | null;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  /** Review-stage output (not a DB column; joined at read time from REVIEW output_ref). */
  consistency?: { warnings: string[]; checked_at: string } | null;
}

export interface StageRow {
  id: string;
  org_id: string;
  run_id: string;
  stage: StageName;
  status: StageStatus;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  tokens_in: number;
  tokens_out: number;
  credits_settled: number;
  provider: string | null;
  model: string | null;
  error_code: string | null;
  error_detail: string | null;
  output_ref: Record<string, unknown>;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  org_id: string;
  project_id: string;
  run_id: string | null;
  template_id: string | null;
  doc_type: DocType;
  title: string;
  current_version_id: string | null;
  latest_version_no: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DocumentVersionRow {
  id: string;
  org_id: string;
  document_id: string;
  version_no: number;
  author_type: "ai" | "user";
  author_id: string | null;
  change_note: string | null;
  content_md: string;
  content_sha256: string;
  sections_count: number;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
}

export interface DocumentSectionRow {
  id: string;
  org_id: string;
  version_id: string;
  ordinal: number;
  anchor: string;
  heading: string;
  body_md: string;
  status: "queued" | "generating" | "done" | "failed";
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExportRow {
  id: string;
  org_id: string;
  document_id: string | null;
  run_id: string | null;
  requested_by: string | null;
  format: "docx" | "pdf" | "md" | "zip";
  status: "queued" | "running" | "ready" | "failed" | "expired";
  s3_key: string | null; // local file path under env.dataDir in dev
  size_bytes: number | null;
  error_code: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShareLinkRow {
  id: string;
  org_id: string;
  document_id: string;
  created_by: string | null;
  token_hash: string; // sha256 hex of the token
  password_hash: string | null;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdempotencyRow {
  id: string;
  org_id: string;
  idem_key: string;
  method: string;
  path: string;
  request_hash: string;
  state: "in_progress" | "completed";
  response_status: number | null;
  response_body: unknown;
  created_at: string;
  expires_at: string;
}

export interface CreditAccountRow {
  id: string;
  org_id: string;
  balance: number;
  reserved: number;
  updated_at: string;
  created_at: string;
}

export interface LedgerRow {
  id: string;
  org_id: string;
  entry_type: LedgerEntryType;
  amount: number;
  run_id: string | null;
  stage: string | null;
  ledger_key: string;
  balance_after: number;
  reserved_after: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SubscriptionRow {
  id: string;
  org_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  plan: Plan;
  status: "active" | "trialing" | "past_due" | "canceled" | "incomplete";
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  last_event_at: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventRow {
  id: string;
  provider: "stripe" | "idp";
  provider_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: "received" | "processed" | "failed" | "ignored";
  attempts: number;
  error: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface OutboxEventRow {
  id: string;
  org_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  trace_context: string | null;
  status: "pending" | "published" | "dead";
  attempts: number;
  available_at: string;
  published_at: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  org_id: string | null;
  actor_user_id: string | null;
  actor_type: "user" | "api_key" | "system";
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface FailedJobRow {
  id: string;
  org_id: string | null;
  queue: string;
  message_id: string;
  run_id: string | null;
  stage: string | null;
  error: string | null;
  payload: Record<string, unknown>;
  receive_count: number;
  first_failed_at: string;
  redriven_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** ===== Auth ===== */

export interface AuthContext {
  userId: string | null; // null for API-key auth
  orgId: string;
  role: Role;
  plan: Plan;
  scopes: string[];
  via: "jwt" | "api_key";
  apiKeyId?: string;
  email?: string;
}

/** ===== SSE ===== */

export interface SSEEvent {
  id: number;
  event: string;
  data: unknown;
  ts: number;
}

export interface GeneratedDocument {
  doc_type: DocType;
  title: string;
  sections: { heading: string; body_md: string }[];
}

export interface StageHandlerResult {
  output_ref: Record<string, unknown>;
  runPatch?: Partial<Pick<RunRow, "glossary" | "input" | "injection_suspected" | "status" | "error_code">>;
  documents?: GeneratedDocument[];
  warnings?: string[];
  skip?: boolean;
}
