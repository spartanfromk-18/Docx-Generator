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
import { nowIso, uuidv7 } from "../util.js";
import { InsufficientCredits, type CreateVersionOutcome, type NewVersionResult, type Repo } from "./repo.js";
import type { CrawlPageRowLite } from "./repo.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * In-memory store that mirrors the Postgres repository semantics:
 * composite (org_id, id) scoping, conditional credit reservation, exactly-once
 * stage settlement, optimistic-concurrency document versions, idempotency keys.
 * Used for zero-setup local dev and CI (USE_MEMORY_DB=true).
 */
export class MemoryRepo implements Repo {
  readonly kind = "memory" as const;

  private users = new Map<string, UserRow>();
  private orgs = new Map<string, OrgRow>();
  private memberships = new Map<string, MembershipRow>();
  private apiKeys = new Map<string, ApiKeyRow>();
  private projects = new Map<string, ProjectRow>();
  private sources = new Map<string, SourceRowLite>();
  private crawlPages: CrawlPageRowLite[] = [];
  private extractions = new Map<string, DesignExtractionRow>(); // by source_id
  private runs = new Map<string, RunRow>();
  private stages = new Map<string, StageRow>();
  private documents = new Map<string, DocumentRow>();
  private versions = new Map<string, DocumentVersionRow>();
  private sections = new Map<string, DocumentSectionRow>();
  private exports = new Map<string, ExportRow>();
  private shareLinks = new Map<string, ShareLinkRow>();
  private idempotency = new Map<string, IdempotencyRow>(); // key `${org_id}:${idem_key}`
  private creditAccounts = new Map<string, CreditAccountRow>();
  private ledger: LedgerRow[] = [];
  private subscriptions = new Map<string, SubscriptionRow>();
  private webhookEvents = new Map<string, WebhookEventRow>();
  private outbox: OutboxEventRow[] = [];
  private auditLogs: AuditRow[] = [];
  private failedJobs = new Map<string, FailedJobRow>();

  async close(): Promise<void> {}
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "in-memory store" };
  }

  // ===== identity & tenancy =====
  async findUserByEmail(email: string): Promise<UserRow | null> {
    for (const u of this.users.values()) if (u.email.toLowerCase() === email.toLowerCase() && !u.deleted_at) return u;
    return null;
  }
  async findUserById(id: string): Promise<UserRow | null> {
    const u = this.users.get(id);
    return u && !u.deleted_at ? u : null;
  }
  async insertUser(u: Omit<UserRow, "created_at" | "updated_at"> & { created_at?: string; updated_at?: string }): Promise<UserRow> {
    const now = nowIso();
    const row: UserRow = { ...u, id: u.id ?? uuidv7(), created_at: u.created_at ?? now, updated_at: u.updated_at ?? now } as UserRow;
    this.users.set(row.id, row);
    return row;
  }
  async markFreeCreditsGranted(userId: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.free_credits_granted_at = nowIso();
  }
  async createOrgWithOwner(
    org: Omit<OrgRow, "created_at" | "updated_at" | "deleted_at">,
    userId: string,
    role: MembershipRow["role"] = "owner",
  ): Promise<OrgRow> {
    const now = nowIso();
    const row: OrgRow = { ...org, id: org.id ?? uuidv7(), created_at: now, updated_at: now, deleted_at: null } as OrgRow;
    this.orgs.set(row.id, row);
    this.memberships.set(`${row.id}:${userId}`, {
      id: uuidv7(),
      org_id: row.id,
      user_id: userId,
      role,
      created_at: now,
      updated_at: now,
    });
    this.creditAccounts.set(row.id, {
      id: uuidv7(),
      org_id: row.id,
      balance: 0,
      reserved: 0,
      updated_at: now,
      created_at: now,
    });
    return row;
  }
  async findOrgById(orgId: string): Promise<OrgRow | null> {
    const o = this.orgs.get(orgId);
    return o && !o.deleted_at ? o : null;
  }
  async findOrgBySlug(slug: string): Promise<OrgRow | null> {
    for (const o of this.orgs.values()) if (o.slug === slug && !o.deleted_at) return o;
    return null;
  }
  async listOrgsForUser(userId: string): Promise<{ org: OrgRow; role: MembershipRow["role"] }[]> {
    const out: { org: OrgRow; role: MembershipRow["role"] }[] = [];
    for (const m of this.memberships.values()) {
      if (m.user_id !== userId) continue;
      const org = this.orgs.get(m.org_id);
      if (org && !org.deleted_at) out.push({ org, role: m.role });
    }
    return out.sort((a, b) => a.org.created_at.localeCompare(b.org.created_at));
  }
  async findMembership(orgId: string, userId: string): Promise<MembershipRow | null> {
    return this.memberships.get(`${orgId}:${userId}`) ?? null;
  }
  async listMembers(orgId: string): Promise<{ membership: MembershipRow; user: Pick<UserRow, "id" | "email" | "display_name"> }[]> {
    const out: { membership: MembershipRow; user: Pick<UserRow, "id" | "email" | "display_name"> }[] = [];
    for (const m of this.memberships.values()) {
      if (m.org_id !== orgId) continue;
      const u = this.users.get(m.user_id);
      if (u) out.push({ membership: m, user: { id: u.id, email: u.email, display_name: u.display_name } });
    }
    return out;
  }
  async updateOrgPlan(orgId: string, plan: OrgRow["plan"]): Promise<void> {
    const o = this.orgs.get(orgId);
    if (o) {
      o.plan = plan;
      o.updated_at = nowIso();
    }
  }

  // ===== api keys =====
  async insertApiKey(k: ApiKeyRow): Promise<ApiKeyRow> {
    this.apiKeys.set(k.id, k);
    return k;
  }
  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    for (const k of this.apiKeys.values()) if (k.prefix === prefix && !k.revoked_at) return k;
    return null;
  }
  async touchApiKey(id: string): Promise<void> {
    const k = this.apiKeys.get(id);
    if (k) k.last_used_at = nowIso();
  }
  async revokeApiKey(orgId: string, id: string): Promise<boolean> {
    const k = this.apiKeys.get(id);
    if (!k || k.org_id !== orgId || k.revoked_at) return false;
    k.revoked_at = nowIso();
    k.updated_at = nowIso();
    return true;
  }
  async listApiKeys(orgId: string): Promise<ApiKeyRow[]> {
    return [...this.apiKeys.values()]
      .filter((k) => k.org_id === orgId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // ===== projects =====
  async insertProject(p: ProjectRow): Promise<ProjectRow> {
    this.projects.set(p.id, p);
    return p;
  }
  async getProject(orgId: string, id: string): Promise<ProjectRow | null> {
    const p = this.projects.get(id);
    return p && p.org_id === orgId && !p.deleted_at ? p : null;
  }
  async listProjects(orgId: string, opts: { q?: string; cursor?: string | null; limit: number }) {
    let items = [...this.projects.values()]
      .filter((p) => p.org_id === orgId && !p.deleted_at)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
      );
    }
    if (opts.cursor) {
      const [cur] = Buffer.from(opts.cursor, "base64url").toString("utf8").split("|");
      items = items.filter((p) => p.updated_at < cur || (p.updated_at === cur && true)); // id tiebreak below
      items = items.filter((p) => !(p.updated_at === cur));
    }
    const page = items.slice(0, opts.limit);
    const next = items.length > opts.limit && page.length > 0 ? page[page.length - 1].updated_at : null;
    return { items: page, nextCursor: next };
  }
  async updateProject(
    orgId: string,
    id: string,
    patch: Partial<Pick<ProjectRow, "name" | "description" | "language" | "idea_text">>,
  ): Promise<ProjectRow | null> {
    const p = this.projects.get(id);
    if (!p || p.org_id !== orgId || p.deleted_at) return null;
    Object.assign(p, patch, { updated_at: nowIso() });
    return p;
  }
  async softDeleteProject(orgId: string, id: string): Promise<boolean> {
    const p = this.projects.get(id);
    if (!p || p.org_id !== orgId || p.deleted_at) return false;
    p.deleted_at = nowIso();
    p.updated_at = p.deleted_at;
    return true;
  }
  async projectSummaries(orgId: string, projectIds: string[]) {
    const map = new Map<string, { documents_count: number; latest_run: { id: string; status: string; mode: string; created_at: string } | null }>();
    for (const pid of projectIds) {
      const docs = [...this.documents.values()].filter((d) => d.org_id === orgId && d.project_id === pid && !d.deleted_at);
      const runs = [...this.runs.values()]
        .filter((r) => r.org_id === orgId && r.project_id === pid)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const lr = runs[0];
      map.set(pid, {
        documents_count: docs.length,
        latest_run: lr ? { id: lr.id, status: lr.status, mode: lr.mode, created_at: lr.created_at } : null,
      });
    }
    return map;
  }

  // ===== reference sources =====
  async insertSource(s: SourceRowLite): Promise<SourceRowLite> {
    this.sources.set(s.id, s);
    return s;
  }
  async getSource(orgId: string, id: string): Promise<SourceRowLite | null> {
    const s = this.sources.get(id);
    return s && s.org_id === orgId ? s : null;
  }
  async getSourceSystem(sourceId: string): Promise<SourceRowLite | null> {
    return this.sources.get(sourceId) ?? null;
  }
  async listSourcesByProject(orgId: string, projectId: string): Promise<SourceRowLite[]> {
    return [...this.sources.values()]
      .filter((s) => s.org_id === orgId && s.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async updateSource(orgId: string, id: string, patch: Partial<SourceRowLite>): Promise<SourceRowLite | null> {
    const s = this.sources.get(id);
    if (!s || s.org_id !== orgId) return null;
    Object.assign(s, patch, { updated_at: nowIso() });
    return s;
  }
  async insertCrawlPages(rows: CrawlPageRowLite[]): Promise<void> {
    this.crawlPages.push(...rows);
  }
  async listCrawlPages(orgId: string, sourceId: string): Promise<CrawlPageRowLite[]> {
    return this.crawlPages
      .filter((p) => p.org_id === orgId && p.source_id === sourceId)
      .sort((a, b) => a.depth - b.depth || a.created_at.localeCompare(b.created_at));
  }
  async upsertDesignExtraction(row: DesignExtractionRow): Promise<DesignExtractionRow> {
    const existing = this.extractions.get(row.source_id);
    if (existing) {
      Object.assign(existing, row, { updated_at: nowIso() });
      return existing;
    }
    this.extractions.set(row.source_id, row);
    return row;
  }
  async getDesignExtraction(orgId: string, sourceId: string): Promise<DesignExtractionRow | null> {
    const e = this.extractions.get(sourceId);
    return e && e.org_id === orgId ? e : null;
  }

  // ===== runs & stages =====
  async createRunWithReservation(run: RunRow, stages: StageRow[], cost: number): Promise<RunRow> {
    const account = this.creditAccounts.get(run.org_id);
    if (!account) throw new InsufficientCredits(cost, 0);
    const available = r2(account.balance - account.reserved);
    if (available < cost) throw new InsufficientCredits(cost, available);
    // single atomic block: reservation + run + stages
    account.reserved = r2(account.reserved + cost);
    account.updated_at = nowIso();
    this.runs.set(run.id, run);
    for (const s of stages) this.stages.set(s.id, s);
    this.ledger.push({
      id: uuidv7(),
      org_id: run.org_id,
      entry_type: "reserve",
      amount: cost,
      run_id: run.id,
      stage: null,
      ledger_key: `reserve:${run.id}`,
      balance_after: account.balance,
      reserved_after: account.reserved,
      metadata: { mode: run.mode },
      created_at: nowIso(),
    });
    return run;
  }
  async getRun(orgId: string, id: string): Promise<RunRow | null> {
    const r = this.runs.get(id);
    return r && r.org_id === orgId ? r : null;
  }
  async getRunSystem(runId: string): Promise<RunRow | null> {
    return this.runs.get(runId) ?? null;
  }
  async listRunsByProject(orgId: string, projectId: string, limit: number): Promise<RunRow[]> {
    return [...this.runs.values()]
      .filter((r) => r.org_id === orgId && r.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  async updateRun(orgId: string, id: string, patch: Partial<RunRow>): Promise<RunRow | null> {
    const r = this.runs.get(id);
    if (!r || r.org_id !== orgId) return null;
    Object.assign(r, patch, { updated_at: nowIso() });
    return r;
  }
  async updateRunSystem(runId: string, patch: Partial<RunRow>): Promise<RunRow | null> {
    const r = this.runs.get(runId);
    if (!r) return null;
    Object.assign(r, patch, { updated_at: nowIso() });
    return r;
  }
  async countActiveRuns(orgId: string): Promise<number> {
    return [...this.runs.values()].filter(
      (r) => r.org_id === orgId && ["queued", "running", "paused_provider"].includes(r.status),
    ).length;
  }
  async listOpenRunIds(): Promise<string[]> {
    return [...this.runs.values()]
      .filter((r) => ["queued", "running", "paused_provider"].includes(r.status))
      .map((r) => r.id);
  }

  async listStages(orgId: string, runId: string): Promise<StageRow[]> {
    return [...this.stages.values()]
      .filter((s) => s.org_id === orgId && s.run_id === runId)
      .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  }
  async listStagesSystem(runId: string): Promise<StageRow[]> {
    return [...this.stages.values()]
      .filter((s) => s.run_id === runId)
      .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  }
  async claimStage(orgId: string, runId: string, stage: StageName, owner: string, leaseSeconds: number): Promise<StageRow | null> {
    const s = [...this.stages.values()].find((x) => x.org_id === orgId && x.run_id === runId && x.stage === stage);
    if (!s) return null;
    const now = new Date();
    const leaseOk = !s.lease_expires_at || new Date(s.lease_expires_at) < now;
    if (!(s.status === "queued" || (s.status === "retry_wait" && (!s.next_attempt_at || new Date(s.next_attempt_at) <= now)))) {
      return null;
    }
    if (!leaseOk) return null;
    s.status = "running";
    s.attempt += 1;
    s.lease_owner = owner;
    s.lease_expires_at = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    s.started_at = s.started_at ?? now.toISOString();
    s.updated_at = nowIso();
    return s;
  }
  async heartbeatStage(orgId: string, stageId: string, owner: string, leaseSeconds: number): Promise<boolean> {
    const s = this.stages.get(stageId);
    if (!s || s.org_id !== orgId || s.status !== "running" || s.lease_owner !== owner) return false;
    s.lease_expires_at = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return true;
  }
  async completeStageSucceeded(
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
  ): Promise<boolean> {
    // Conditional transition — only the winning transaction settles (TRD D1).
    const s = [...this.stages.values()].find((x) => x.org_id === orgId && x.run_id === runId && x.stage === stage);
    if (!s || s.status !== "running" || s.attempt !== attempt) return false;

    const account = this.creditAccounts.get(orgId);
    if (!account) return false;

    for (const d of opts.documents ?? []) {
      this.documents.set(d.doc.id, d.doc);
      this.versions.set(d.version.id, d.version);
      for (const sec of d.sections) {
        const now = nowIso();
        const row: DocumentSectionRow = {
          ...(sec as Omit<DocumentSectionRow, "org_id" | "version_id" | "created_at" | "updated_at">),
          org_id: orgId,
          version_id: d.version.id,
          created_at: now,
          updated_at: now,
        } as DocumentSectionRow;
        this.sections.set(row.id, row);
      }
      // document pointer to current version
      d.doc.current_version_id = d.version.id;
      d.doc.latest_version_no = d.version.version_no;
    }

    s.status = "succeeded";
    s.finished_at = nowIso();
    s.lease_owner = null;
    s.lease_expires_at = null;
    s.error_code = null;
    s.error_detail = null;
    Object.assign(s, stagePatch);
    s.updated_at = nowIso();

    if (opts.ledger.amount > 0) {
      account.balance = r2(account.balance - opts.ledger.amount);
      account.reserved = r2(Math.max(0, account.reserved - opts.ledger.amount));
      account.updated_at = nowIso();
      this.ledger.push({
        id: uuidv7(),
        org_id: orgId,
        entry_type: opts.ledger.entry_type,
        amount: opts.ledger.amount,
        run_id: runId,
        stage,
        ledger_key: opts.ledger.ledger_key,
        balance_after: account.balance,
        reserved_after: account.reserved,
        metadata: { attempt },
        created_at: nowIso(),
      });
    }

    const run = this.runs.get(runId);
    if (run) {
      run.tokens_in += stagePatch.tokens_in;
      run.tokens_out += stagePatch.tokens_out;
      run.llm_calls += 1;
      run.credits_settled = r2(run.credits_settled + stagePatch.credits_settled);
      if (opts.runPatch) Object.assign(run, opts.runPatch, { updated_at: nowIso() });
    }
    return true;
  }
  async failStageAttempt(
    orgId: string,
    runId: string,
    stage: StageName,
    attempt: number,
    errorCode: string,
    errorDetail: string,
    nextAttemptAt: string | null,
    releaseReserved: number,
  ): Promise<boolean> {
    const s = [...this.stages.values()].find((x) => x.org_id === orgId && x.run_id === runId && x.stage === stage);
    if (!s || s.status !== "running" || s.attempt !== attempt) return false;
    s.status = nextAttemptAt ? "retry_wait" : "failed";
    s.error_code = errorCode;
    s.error_detail = errorDetail;
    s.next_attempt_at = nextAttemptAt;
    s.finished_at = nextAttemptAt ? null : nowIso();
    s.lease_owner = null;
    s.lease_expires_at = null;
    s.updated_at = nowIso();

    if (releaseReserved > 0) {
      const account = this.creditAccounts.get(orgId);
      if (account) {
        account.reserved = r2(Math.max(0, account.reserved - releaseReserved));
        account.updated_at = nowIso();
        this.ledger.push({
          id: uuidv7(),
          org_id: orgId,
          entry_type: "release",
          amount: releaseReserved,
          run_id: runId,
          stage,
          ledger_key: `release:${runId}:${stage}:${attempt}`,
          balance_after: account.balance,
          reserved_after: account.reserved,
          metadata: { reason: errorCode },
          created_at: nowIso(),
        });
      }
    }
    return true;
  }

  async resetStageForRetry(orgId: string, runId: string, stage: StageName): Promise<boolean> {
    const s = [...this.stages.values()].find((x) => x.org_id === orgId && x.run_id === runId && x.stage === stage);
    if (!s || s.status !== "failed") return false;
    s.status = "queued";
    s.next_attempt_at = null;
    s.error_code = null;
    s.error_detail = null;
    s.finished_at = null;
    s.lease_owner = null;
    s.lease_expires_at = null;
    s.updated_at = nowIso();
    return true;
  }

  // ===== documents, versions, sections =====
  async getDocument(orgId: string, id: string): Promise<DocumentRow | null> {
    const d = this.documents.get(id);
    return d && d.org_id === orgId && !d.deleted_at ? d : null;
  }
  async listDocumentsByProject(orgId: string, projectId: string): Promise<DocumentRow[]> {
    return [...this.documents.values()]
      .filter((d) => d.org_id === orgId && d.project_id === projectId && !d.deleted_at)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async getDocumentVersion(orgId: string, documentId: string, versionNo: number | "current"): Promise<NewVersionResult | null> {
    const doc = this.documents.get(documentId);
    if (!doc || doc.org_id !== orgId) return null;
    const v =
      versionNo === "current"
        ? [...this.versions.values()].find((x) => x.id === doc.current_version_id)
        : [...this.versions.values()].find((x) => x.document_id === documentId && x.version_no === versionNo);
    if (!v) return null;
    const sections = [...this.sections.values()]
      .filter((s) => s.version_id === v.id)
      .sort((a, b) => a.ordinal - b.ordinal);
    return { version: v, sections };
  }
  async listVersions(orgId: string, documentId: string): Promise<DocumentVersionRow[]> {
    return [...this.versions.values()]
      .filter((v) => v.org_id === orgId && v.document_id === documentId)
      .sort((a, b) => b.version_no - a.version_no);
  }
  async createNewVersion(
    orgId: string,
    documentId: string,
    baseVersionNo: number,
    edits: Map<string, string>,
    opts: { changeNote: string | null; authorId: string | null; authorType: "ai" | "user"; model?: string | null; ledger?: { amount: number; ledger_key: string } },
  ): Promise<CreateVersionOutcome> {
    const doc = this.documents.get(documentId);
    if (!doc || doc.org_id !== orgId || doc.deleted_at) return "CONFLICT";
    if (doc.latest_version_no !== baseVersionNo) return "CONFLICT";

    const current = await this.getDocumentVersion(orgId, documentId, "current");
    if (!current) return "CONFLICT";

    const account = this.creditAccounts.get(orgId);
    if (opts.ledger && account) {
      const available = r2(account.balance - account.reserved);
      if (available < opts.ledger.amount) throw new InsufficientCredits(opts.ledger.amount, available);
      account.reserved = r2(account.reserved + opts.ledger.amount);
    }

    const now = nowIso();
    const versionNo = doc.latest_version_no + 1;
    const version: DocumentVersionRow = {
      id: uuidv7(),
      org_id: orgId,
      document_id: documentId,
      version_no: versionNo,
      author_type: opts.authorType,
      author_id: opts.authorId,
      change_note: opts.changeNote,
      content_md: "",
      content_sha256: "",
      sections_count: current.sections.length,
      model: opts.model ?? null,
      tokens_in: 0,
      tokens_out: 0,
      created_at: now,
    };
    let fullMd = "";
    const newSections: DocumentSectionRow[] = [];
    for (const sec of current.sections) {
      const body = edits.get(sec.id) ?? sec.body_md;
      fullMd += `## ${sec.heading}\n\n${body}\n\n`;
      newSections.push({
        ...sec,
        id: uuidv7(),
        version_id: version.id,
        body_md: body,
        status: "done",
        error_code: null,
        created_at: now,
        updated_at: now,
      });
    }
    version.content_md = fullMd;
    version.content_sha256 = Buffer.from(fullMd).toString("base64");

    this.versions.set(version.id, version);
    for (const s of newSections) this.sections.set(s.id, s);
    doc.latest_version_no = versionNo;
    doc.current_version_id = version.id;
    doc.updated_at = now;

    if (opts.ledger && account) {
      account.balance = r2(account.balance - opts.ledger.amount);
      account.reserved = r2(Math.max(0, account.reserved - opts.ledger.amount));
      account.updated_at = now;
      this.ledger.push({
        id: uuidv7(),
        org_id: orgId,
        entry_type: "settle",
        amount: opts.ledger.amount,
        run_id: doc.run_id,
        stage: "REGEN",
        ledger_key: opts.ledger.ledger_key,
        balance_after: account.balance,
        reserved_after: account.reserved,
        metadata: { document_id: documentId },
        created_at: now,
      });
    }
    return { version, sections: newSections };
  }
  async getSectionWithDocument(orgId: string, sectionId: string) {
    const section = this.sections.get(sectionId);
    if (!section || section.org_id !== orgId) return null;
    const version = this.versions.get(section.version_id);
    const document = version ? this.documents.get(version.document_id) : undefined;
    if (!version || !document || document.org_id !== orgId) return null;
    return { section, version, document };
  }

  // ===== exports =====
  async insertExport(e: ExportRow): Promise<ExportRow> {
    this.exports.set(e.id, e);
    return e;
  }
  async getExport(orgId: string, id: string): Promise<ExportRow | null> {
    const e = this.exports.get(id);
    return e && e.org_id === orgId ? e : null;
  }
  async updateExport(orgId: string, id: string, patch: Partial<ExportRow>): Promise<ExportRow | null> {
    const e = this.exports.get(id);
    if (!e || e.org_id !== orgId) return null;
    Object.assign(e, patch, { updated_at: nowIso() });
    return e;
  }

  // ===== share links =====
  async insertShareLink(s: ShareLinkRow): Promise<ShareLinkRow> {
    this.shareLinks.set(s.id, s);
    return s;
  }
  async findShareLinkByTokenHash(tokenHash: string): Promise<{ link: ShareLinkRow; document: DocumentRow } | null> {
    for (const l of this.shareLinks.values()) {
      if (l.token_hash === tokenHash) {
        const doc = this.documents.get(l.document_id);
        if (doc) return { link: l, document: doc };
      }
    }
    return null;
  }
  async revokeShareLink(orgId: string, id: string): Promise<boolean> {
    const l = this.shareLinks.get(id);
    if (!l || l.org_id !== orgId || l.revoked_at) return false;
    l.revoked_at = nowIso();
    l.updated_at = l.revoked_at;
    return true;
  }
  async touchShareView(orgId: string, id: string): Promise<void> {
    const l = this.shareLinks.get(id);
    if (l) {
      l.view_count += 1;
      l.last_viewed_at = nowIso();
    }
  }

  // ===== idempotency =====
  private idemKey(orgId: string, key: string): string {
    return `${orgId}:${key}`;
  }
  async getIdempotency(orgId: string, idemKey: string): Promise<IdempotencyRow | null> {
    return this.idempotency.get(this.idemKey(orgId, idemKey)) ?? null;
  }
  async insertIdempotencyInProgress(row: IdempotencyRow): Promise<boolean> {
    const k = this.idemKey(row.org_id, row.idem_key);
    if (this.idempotency.has(k)) return false;
    this.idempotency.set(k, row);
    return true;
  }
  async completeIdempotency(orgId: string, idemKey: string, status: number, body: unknown): Promise<void> {
    const row = this.idempotency.get(this.idemKey(orgId, idemKey));
    if (row) {
      row.state = "completed";
      row.response_status = status;
      row.response_body = body;
    }
  }

  // ===== credits ledger =====
  async getCreditAccount(orgId: string): Promise<CreditAccountRow> {
    let a = this.creditAccounts.get(orgId);
    if (!a) {
      a = { id: uuidv7(), org_id: orgId, balance: 0, reserved: 0, updated_at: nowIso(), created_at: nowIso() };
      this.creditAccounts.set(orgId, a);
    }
    return a;
  }
  async reserveCredits(orgId: string, amount: number): Promise<{ balance: number; reserved: number }> {
    const a = await this.getCreditAccount(orgId);
    const available = r2(a.balance - a.reserved);
    if (available < amount) throw new InsufficientCredits(amount, available);
    a.reserved = r2(a.reserved + amount);
    a.updated_at = nowIso();
    return { balance: a.balance, reserved: a.reserved };
  }
  async releaseCredits(orgId: string, runId: string | null, amount: number, ledgerKey: string, stage?: string): Promise<void> {
    if (amount <= 0) return;
    const a = await this.getCreditAccount(orgId);
    a.reserved = r2(Math.max(0, a.reserved - amount));
    a.updated_at = nowIso();
    this.ledger.push({
      id: uuidv7(),
      org_id: orgId,
      entry_type: "release",
      amount,
      run_id: runId,
      stage: stage ?? null,
      ledger_key: ledgerKey,
      balance_after: a.balance,
      reserved_after: a.reserved,
      metadata: {},
      created_at: nowIso(),
    });
  }
  async grantCredits(orgId: string, amount: number, ledgerKey: string, meta: Record<string, unknown>): Promise<boolean> {
    if (this.ledger.some((l) => l.org_id === orgId && l.ledger_key === ledgerKey)) return false;
    const a = await this.getCreditAccount(orgId);
    a.balance = r2(a.balance + amount);
    a.updated_at = nowIso();
    this.ledger.push({
      id: uuidv7(),
      org_id: orgId,
      entry_type: (meta.entry_type as LedgerEntryType) ?? "grant",
      amount,
      run_id: null,
      stage: null,
      ledger_key: ledgerKey,
      balance_after: a.balance,
      reserved_after: a.reserved,
      metadata: meta,
      created_at: nowIso(),
    });
    return true;
  }
  async listLedger(orgId: string, limit: number): Promise<LedgerRow[]> {
    return this.ledger
      .filter((l) => l.org_id === orgId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  // ===== subscriptions & webhooks =====
  async upsertSubscription(s: SubscriptionRow): Promise<SubscriptionRow> {
    const existing = this.subscriptions.get(s.org_id);
    if (existing) {
      Object.assign(existing, s, { updated_at: nowIso() });
      return existing;
    }
    this.subscriptions.set(s.org_id, s);
    return s;
  }
  async getSubscription(orgId: string): Promise<SubscriptionRow | null> {
    return this.subscriptions.get(orgId) ?? null;
  }
  async insertWebhookEvent(w: WebhookEventRow): Promise<boolean> {
    const k = `${w.provider}:${w.provider_event_id}`;
    for (const e of this.webhookEvents.values()) if (`${e.provider}:${e.provider_event_id}` === k) return false;
    this.webhookEvents.set(w.id, w);
    return true;
  }
  async updateWebhookEvent(id: string, patch: Partial<WebhookEventRow>): Promise<void> {
    const e = this.webhookEvents.get(id);
    if (e) Object.assign(e, patch);
  }
  async updateWebhookEventByProviderId(providerEventId: string, patch: Partial<WebhookEventRow>): Promise<void> {
    for (const e of this.webhookEvents.values()) {
      if (e.provider_event_id === providerEventId) Object.assign(e, patch);
    }
  }

  // ===== outbox, audit, failed jobs =====
  async emitOutbox(rows: Omit<OutboxEventRow, "status" | "attempts" | "published_at">[]): Promise<void> {
    for (const row of rows) {
      this.outbox.push({ ...row, status: "published", attempts: 1, published_at: nowIso() });
    }
  }
  async writeAudit(rows: Omit<AuditRow, "id">[]): Promise<void> {
    for (const row of rows) this.auditLogs.push({ ...row, id: uuidv7() });
  }
  async recordFailedJob(row: Omit<FailedJobRow, "id" | "created_at" | "updated_at">): Promise<void> {
    const k = `${row.queue}:${row.message_id}`;
    for (const j of this.failedJobs.values()) if (`${j.queue}:${j.message_id}` === k) return;
    const now = nowIso();
    this.failedJobs.set(uuidv7(), { ...row, id: uuidv7(), created_at: now, updated_at: now });
  }

  // ===== GDPR =====
  async exportUserData(orgId: string, userId: string): Promise<Record<string, unknown>> {
    const projects = [...this.projects.values()].filter((p) => p.org_id === orgId);
    const docs = [...this.documents.values()].filter((d) => d.org_id === orgId);
    const docPayload = docs.map((d) => {
      const v = this.versions.get(d.current_version_id ?? "");
      const sections = v
        ? [...this.sections.values()].filter((s) => s.version_id === v.id).sort((a, b) => a.ordinal - b.ordinal)
        : [];
      return { ...d, sections: sections.map((s) => ({ heading: s.heading, body_md: s.body_md })) };
    });
    return {
      exported_at: nowIso(),
      org: this.orgs.get(orgId),
      projects,
      documents: docPayload,
      ledger: this.ledger.filter((l) => l.org_id === orgId),
    };
  }
  async deleteOrgData(orgId: string): Promise<void> {
    for (const [id, p] of this.projects) if (p.org_id === orgId) this.projects.delete(id);
    for (const [id, d] of this.documents) if (d.org_id === orgId) this.documents.delete(id);
    for (const [id, r] of this.runs) if (r.org_id === orgId) this.runs.delete(id);
    const org = this.orgs.get(orgId);
    if (org) {
      org.deleted_at = nowIso();
      org.name = `deleted-org-${org.id.slice(0, 8)}`;
      org.slug = `deleted-${org.id.slice(0, 8)}`;
    }
  }
}

type SourceRowLite = import("../types.js").SourceRow;
