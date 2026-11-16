import type {
  ApiKeyRow,
  AuditRow,
  CreditAccountRow,
  DesignExtractionRow,
  DocumentRow,
  DocumentSectionRow,
  DocumentVersionRow,
  ExportRow,
  FailedJobRow,
  IdempotencyRow,
  LedgerEntryType,
  LedgerRow,
  MembershipRow,
  OrgRow,
  OutboxEventRow,
  ProjectRow,
  RunRow,
  ShareLinkRow,
  SourceRow,
  StageName,
  StageRow,
  SubscriptionRow,
  UserRow,
  WebhookEventRow,
} from "../types.js";

/**
 * Repository contract shared by the in-memory backend (zero-setup dev/CI)
 * and the PostgreSQL backend (production-shaped, RLS via SET LOCAL app.org_id).
 *
 * Every tenant-scoped method takes orgId explicitly — mirroring the composite
 * (org_id, id) keys in the schema so cross-tenant references are impossible.
 */

export class InsufficientCredits extends Error {
  constructor(
    public required: number,
    public available: number,
  ) {
    super(`Needs ${required} credits; ${available} available.`);
    this.name = "InsufficientCredits";
  }
  get shortfall(): number {
    return Math.max(0, this.required - this.available);
  }
}

export interface NewVersionResult {
  version: DocumentVersionRow;
  sections: DocumentSectionRow[];
}
export type CreateVersionOutcome = NewVersionResult | "CONFLICT";

export interface Repo {
  readonly kind: "memory" | "postgres";
  close(): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;

  // ===== identity & tenancy (system-level operations) =====
  findUserByEmail(email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  insertUser(u: Omit<UserRow, "created_at" | "updated_at"> & { created_at?: string; updated_at?: string }): Promise<UserRow>;
  markFreeCreditsGranted(userId: string): Promise<void>;
  createOrgWithOwner(org: Omit<OrgRow, "created_at" | "updated_at" | "deleted_at">, userId: string, role?: MembershipRow["role"]): Promise<OrgRow>;
  findOrgById(orgId: string): Promise<OrgRow | null>;
  findOrgBySlug(slug: string): Promise<OrgRow | null>;
  listOrgsForUser(userId: string): Promise<{ org: OrgRow; role: MembershipRow["role"] }[]>;
  findMembership(orgId: string, userId: string): Promise<MembershipRow | null>;
  listMembers(orgId: string): Promise<{ membership: MembershipRow; user: Pick<UserRow, "id" | "email" | "display_name"> }[]>;
  updateOrgPlan(orgId: string, plan: OrgRow["plan"]): Promise<void>;

  // ===== api keys =====
  insertApiKey(k: ApiKeyRow): Promise<ApiKeyRow>;
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
  touchApiKey(id: string): Promise<void>;
  revokeApiKey(orgId: string, id: string): Promise<boolean>;
  listApiKeys(orgId: string): Promise<ApiKeyRow[]>;

  // ===== projects =====
  insertProject(p: ProjectRow): Promise<ProjectRow>;
  getProject(orgId: string, id: string): Promise<ProjectRow | null>;
  listProjects(
    orgId: string,
    opts: { q?: string; cursor?: string | null; limit: number },
  ): Promise<{ items: ProjectRow[]; nextCursor: string | null }>;
  updateProject(
    orgId: string,
    id: string,
    patch: Partial<Pick<ProjectRow, "name" | "description" | "language" | "idea_text">>,
  ): Promise<ProjectRow | null>;
  softDeleteProject(orgId: string, id: string): Promise<boolean>;
  projectSummaries(
    orgId: string,
    projectIds: string[],
  ): Promise<Map<string, { documents_count: number; latest_run: { id: string; status: string; mode: string; created_at: string } | null }>>;

  // ===== reference sources =====
  insertSource(s: SourceRow): Promise<SourceRow>;
  getSource(orgId: string, id: string): Promise<SourceRow | null>;
  getSourceSystem(sourceId: string): Promise<SourceRow | null>; // worker path (no tenant ctx)
  listSourcesByProject(orgId: string, projectId: string): Promise<SourceRow[]>;
  updateSource(orgId: string, id: string, patch: Partial<SourceRow>): Promise<SourceRow | null>;
  insertCrawlPages(rows: CrawlPageRowLite[]): Promise<void>;
  listCrawlPages(orgId: string, sourceId: string): Promise<CrawlPageRowLite[]>;
  upsertDesignExtraction(row: DesignExtractionRow): Promise<DesignExtractionRow>;
  getDesignExtraction(orgId: string, sourceId: string): Promise<DesignExtractionRow | null>;

  // ===== runs & stages =====
  /** Reserve credits and insert run + stage rows in ONE transaction (TRD D2). Throws InsufficientCredits. */
  createRunWithReservation(run: RunRow, stages: StageRow[], cost: number): Promise<RunRow>;
  getRun(orgId: string, id: string): Promise<RunRow | null>;
  getRunSystem(runId: string): Promise<RunRow | null>;
  listRunsByProject(orgId: string, projectId: string, limit: number): Promise<RunRow[]>;
  updateRun(orgId: string, id: string, patch: Partial<RunRow>): Promise<RunRow | null>;
  updateRunSystem(runId: string, patch: Partial<RunRow>): Promise<RunRow | null>;
  countActiveRuns(orgId: string): Promise<number>;
  /** Engine scan: runs that still need work, across all tenants (system role per TRD Q9). */
  listOpenRunIds(): Promise<string[]>;

  listStages(orgId: string, runId: string): Promise<StageRow[]>;
  listStagesSystem(runId: string): Promise<StageRow[]>;
  claimStage(orgId: string, runId: string, stage: StageName, owner: string, leaseSeconds: number): Promise<StageRow | null>;
  heartbeatStage(orgId: string, stageId: string, owner: string, leaseSeconds: number): Promise<boolean>;
  /**
   * Exactly-once completion: conditional transition running→succeeded in the same
   * transaction as document writes, ledger settlement and run counters (TRD D1).
   */
  completeStageSucceeded(
    orgId: string,
    runId: string,
    stage: StageName,
    attempt: number,
    stagePatch: {
      output_ref: Record<string, unknown>;
      tokens_in: number;
      tokens_out: number;
      credits_settled: number;
      provider: string | null;
      model: string | null;
    },
    opts: {
      ledger: { amount: number; ledger_key: string; entry_type: LedgerEntryType };
      runPatch?: Partial<RunRow>;
      documents?: { doc: DocumentRow; version: DocumentVersionRow; sections: Omit<DocumentSectionRow, "org_id" | "version_id" | "created_at" | "updated_at">[] }[];
    },
  ): Promise<boolean>;
  /** Conditional failure transition; nextAttemptAt null ⇒ terminal failed. */
  failStageAttempt(
    orgId: string,
    runId: string,
    stage: StageName,
    attempt: number,
    errorCode: string,
    errorDetail: string,
    nextAttemptAt: string | null,
    releaseReserved: number,
  ): Promise<boolean>;
  /** Retry path: failed stage → queued (attempt preserved). */
  resetStageForRetry(orgId: string, runId: string, stage: StageName): Promise<boolean>;

  // ===== documents, versions, sections =====
  getDocument(orgId: string, id: string): Promise<DocumentRow | null>;
  listDocumentsByProject(orgId: string, projectId: string): Promise<DocumentRow[]>;
  getDocumentVersion(
    orgId: string,
    documentId: string,
    versionNo: number | "current",
  ): Promise<NewVersionResult | null>;
  listVersions(orgId: string, documentId: string): Promise<DocumentVersionRow[]>;
  /** Optimistic concurrency: baseVersionNo must equal latest, else CONFLICT (TRD D3). */
  createNewVersion(
    orgId: string,
    documentId: string,
    baseVersionNo: number,
    edits: Map<string, string>,
    opts: { changeNote: string | null; authorId: string | null; authorType: "ai" | "user"; model?: string | null; ledger?: { amount: number; ledger_key: string } },
  ): Promise<CreateVersionOutcome>;
  getSectionWithDocument(orgId: string, sectionId: string): Promise<{ section: DocumentSectionRow; version: DocumentVersionRow; document: DocumentRow } | null>;

  // ===== exports =====
  insertExport(e: ExportRow): Promise<ExportRow>;
  getExport(orgId: string, id: string): Promise<ExportRow | null>;
  updateExport(orgId: string, id: string, patch: Partial<ExportRow>): Promise<ExportRow | null>;

  // ===== share links =====
  insertShareLink(s: ShareLinkRow): Promise<ShareLinkRow>;
  findShareLinkByTokenHash(tokenHash: string): Promise<{ link: ShareLinkRow; document: DocumentRow } | null>;
  revokeShareLink(orgId: string, id: string): Promise<boolean>;
  touchShareView(orgId: string, id: string): Promise<void>;

  // ===== idempotency =====
  getIdempotency(orgId: string, idemKey: string): Promise<IdempotencyRow | null>;
  insertIdempotencyInProgress(row: IdempotencyRow): Promise<boolean>; // false on duplicate
  completeIdempotency(orgId: string, idemKey: string, status: number, body: unknown): Promise<void>;

  // ===== credits ledger =====
  getCreditAccount(orgId: string): Promise<CreditAccountRow>;
  reserveCredits(orgId: string, amount: number): Promise<{ balance: number; reserved: number }>; // throws InsufficientCredits
  releaseCredits(orgId: string, runId: string | null, amount: number, ledgerKey: string, stage?: string): Promise<void>;
  grantCredits(orgId: string, amount: number, ledgerKey: string, meta: Record<string, unknown>): Promise<boolean>; // exactly-once by ledger_key
  listLedger(orgId: string, limit: number): Promise<LedgerRow[]>;

  // ===== subscriptions & webhooks =====
  upsertSubscription(s: SubscriptionRow): Promise<SubscriptionRow>;
  getSubscription(orgId: string): Promise<SubscriptionRow | null>;
  insertWebhookEvent(w: WebhookEventRow): Promise<boolean>; // false if duplicate (UNIQUE provider,provider_event_id)
  updateWebhookEvent(id: string, patch: Partial<WebhookEventRow>): Promise<void>;
  updateWebhookEventByProviderId(providerEventId: string, patch: Partial<WebhookEventRow>): Promise<void>;

  // ===== outbox, audit, failed jobs =====
  emitOutbox(rows: Omit<OutboxEventRow, "status" | "attempts" | "published_at">[]): Promise<void>;
  writeAudit(rows: Omit<AuditRow, "id">[]): Promise<void>;
  recordFailedJob(row: Omit<FailedJobRow, "id" | "created_at" | "updated_at">): Promise<void>;

  // ===== user data controls (GDPR) =====
  exportUserData(orgId: string, userId: string): Promise<Record<string, unknown>>;
  deleteOrgData(orgId: string): Promise<void>;
}

export interface CrawlPageRowLite {
  id: string;
  org_id: string;
  source_id: string;
  url: string;
  url_sha256: string;
  depth: number;
  state: "captured" | "partial" | "skipped";
  skip_reason: string | null;
  http_status: number | null;
  title: string | null;
  template_cluster: string | null;
  thumbnail_s3_key: string | null;
  content_sha256: string | null;
  a11y_summary: Record<string, unknown>;
  created_at: string;
}

export async function createRepo(): Promise<Repo> {
  const { env } = await import("../env.js");
  if (env.useMemoryDb) {
    const { MemoryRepo } = await import("./memory.js");
    return new MemoryRepo();
  }
  const { PostgresRepo } = await import("./postgres.js");
  return PostgresRepo.create();
}
