import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { env } from "../env.js";
import { nowIso, uuidv7 } from "../util.js";
import { InsufficientCredits, type CreateVersionOutcome, type NewVersionResult, type Repo } from "./repo.js";
import type { CrawlPageRowLite } from "./repo.js";
import type {
  ApiKeyRow, AuditRow, CreditAccountRow, DesignExtractionRow, DocumentRow, DocumentSectionRow,
  DocumentVersionRow, ExportRow, IdempotencyRow, LedgerEntryType, LedgerRow, MembershipRow, OrgRow,
  OutboxEventRow, Plan, ProjectRow, Role, RunRow, ShareLinkRow, SourceRow, StageName, StageRow,
  SubscriptionRow, UserRow, WebhookEventRow,
} from "../types.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Query function handed to transaction callbacks. */
type Q = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/**
 * PostgreSQL repository. Connects as the least-privileged roles from the spec
 * schema: app_api (tenant ops, RLS enforced with SET LOCAL app.org_id) and
 * app_system (bootstrap/identity operations, BYPASSRLS) — TRD 2.6 defence in
 * depth. scripts/init_db.sql is applied on first boot if the schema is absent.
 */

function camelize(row: QueryResultRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

export class PostgresRepo implements Repo {
  readonly kind = "postgres" as const;
  private apiPool!: Pool;
  private systemPool!: Pool;

  static async create(): Promise<PostgresRepo> {
    const repo = new PostgresRepo();
    await repo.bootstrap();
    return repo;
  }

  private async bootstrap(): Promise<void> {
    // 1) Bootstrap as the superuser from DATABASE_URL: ensure schema + role logins.
    const admin = new Pool({ connectionString: env.databaseUrl, max: 2 });
    try {
      const adminClient = await admin.connect();
      try {
        const schemaPath = env.dataDir.endsWith(".data") ? join(env.dataDir, "..", "..", "scripts", "init_db.sql") : "scripts/init_db.sql";
        const existing = await adminClient.query("SELECT to_regclass('public.organizations') AS t");
        if (!existing.rows[0]?.t) {
          const candidates = [schemaPath, "scripts/init_db.sql", "../scripts/init_db.sql", "/opt/specforge/init_db.sql"];
          const file = candidates.find((c) => existsSync(c));
          if (!file) throw new Error("init_db.sql not found");
          const ddl = readFileSync(file, "utf8");
          await adminClient.query(ddl);
          console.log("[db] applied scripts/init_db.sql");
        }
        // Dev bootstrap: give the spec roles logins (production provisions secrets instead).
        await adminClient.query(`ALTER ROLE app_api LOGIN PASSWORD '${env.dbRolePasswordApi.replace(/'/g, "")}'`);
        await adminClient.query(`ALTER ROLE app_system LOGIN PASSWORD '${env.dbRolePasswordSystem.replace(/'/g, "")}'`);
        await adminClient.query("GRANT CONNECT ON DATABASE current_database() TO app_api, app_system").catch(() => {});
      } finally {
        adminClient.release();
      }
    } finally {
      await admin.end().catch(() => {});
    }

    // 2) App pools per TRD 2.3 connection budget (5 per API pod / small system pool).
    const url = new URL(env.databaseUrl);
    const dbName = url.pathname.replace(/^\//, "");
    this.apiPool = new Pool({
      user: "app_api",
      password: env.dbRolePasswordApi,
      host: url.hostname,
      port: Number(url.port || 5432),
      database: dbName,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.systemPool = new Pool({
      user: "app_system",
      password: env.dbRolePasswordSystem,
      host: url.hostname,
      port: Number(url.port || 5432),
      database: dbName,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  async close(): Promise<void> {
    await this.apiPool.end().catch(() => {});
    await this.systemPool.end().catch(() => {});
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.systemPool.query("SELECT 1 AS ok");
      return { ok: r.rowCount === 1, detail: "postgres reachable" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "unreachable" };
    }
  }

  /** Tenant transaction: BEGIN + SET LOCAL app.org_id + work + COMMIT. */
  private async tx<T>(orgId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
    const pool = orgId ? this.apiPool : this.systemPool;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (orgId) await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const q: Q = (sql, params) => client.query(sql, params as unknown[]);
      const out = await fn(q);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async one<T extends QueryResultRow>(orgId: string | null, sql: string, params: unknown[] = []): Promise<T | null> {
    return this.tx(orgId, async (q) => {
      const r = await q(sql, params);
      return (r.rows[0] as T) ?? null;
    });
  }
  private async many<T extends QueryResultRow>(orgId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.tx(orgId, async (q) => (await q(sql, params)).rows as T[]);
  }
  private async exec(orgId: string | null, sql: string, params: unknown[] = []): Promise<number | null> {
    return this.tx(orgId, async (q) => (await q(sql, params)).rowCount);
  }

  // ===== identity & tenancy =====
  async findUserByEmail(email: string): Promise<UserRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1", [email]);
    return r ? (camelize(r) as unknown as UserRow) : null;
  }
  async findUserById(id: string): Promise<UserRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1", [id]);
    return r ? (camelize(r) as unknown as UserRow) : null;
  }
  async insertUser(u: Partial<UserRow> & Pick<UserRow, "email" | "idp_subject">): Promise<UserRow> {
    const r = await this.one<Record<string, unknown>>(
      null,
      `INSERT INTO users (id, email, email_verified_at, display_name, idp_subject, locale, risk_score, free_credits_granted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [u.id ?? uuidv7(), u.email, u.email_verified_at ?? null, u.display_name ?? null, u.idp_subject, u.locale ?? "en", u.risk_score ?? 0, u.free_credits_granted_at ?? null],
    );
    return camelize(r as QueryResultRow) as unknown as UserRow;
  }
  async markFreeCreditsGranted(userId: string): Promise<void> {
    await this.exec(null, "UPDATE users SET free_credits_granted_at = now() WHERE id = $1", [userId]);
  }
  async createOrgWithOwner(org: Partial<OrgRow> & Pick<OrgRow, "name" | "slug">, userId: string, role: Role = "owner"): Promise<OrgRow> {
    return this.tx(null, async (q) => {
      const orgRow = await q(
        `INSERT INTO organizations (id, name, slug, plan, data_region, is_personal) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [org.id ?? uuidv7(), org.name, org.slug, org.plan ?? "free", org.data_region ?? "us", org.is_personal ?? true],
      );
      const o = camelize(orgRow.rows[0]) as unknown as OrgRow;
      await q(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3)`, [o.id, userId, role]);
      await q(`INSERT INTO credit_accounts (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`, [o.id]);
      return o;
    });
  }
  async findOrgById(orgId: string): Promise<OrgRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM organizations WHERE id = $1 AND deleted_at IS NULL", [orgId]);
    return r ? (camelize(r) as unknown as OrgRow) : null;
  }
  async findOrgBySlug(slug: string): Promise<OrgRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM organizations WHERE slug = $1 AND deleted_at IS NULL", [slug]);
    return r ? (camelize(r) as unknown as OrgRow) : null;
  }
  async listOrgsForUser(userId: string): Promise<{ org: OrgRow; role: Role }[]> {
    const rows = await this.many<Record<string, unknown>>(
      null,
      `SELECT o.*, m.role AS member_role FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1 AND o.deleted_at IS NULL ORDER BY o.created_at`,
      [userId],
    );
    return rows.map((row) => {
      const org = camelize(row) as unknown as OrgRow;
      return { org, role: row.member_role as Role };
    });
  }
  async findMembership(orgId: string, userId: string): Promise<MembershipRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM memberships WHERE org_id = $1 AND user_id = $2 LIMIT 1", [orgId, userId]);
    return r ? (camelize(r) as unknown as MembershipRow) : null;
  }
  async listMembers(orgId: string): Promise<{ membership: MembershipRow; user: Pick<UserRow, "id" | "email" | "display_name"> }[]> {
    const rows = await this.many<Record<string, unknown>>(
      null,
      `SELECT m.*, u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`,
      [orgId],
    );
    return rows.map((row) => {
      const membership = camelize({ ...row, email: undefined, display_name: undefined }) as unknown as MembershipRow;
      return { membership, user: { id: row.user_id as string, email: row.email as string, display_name: row.display_name as string | null } };
    });
  }
  async updateOrgPlan(orgId: string, plan: Plan): Promise<void> {
    await this.exec(null, "UPDATE organizations SET plan = $2 WHERE id = $1", [orgId, plan]);
  }

  // ===== api keys =====
  async insertApiKey(k: ApiKeyRow): Promise<ApiKeyRow> {
    const r = await this.one<Record<string, unknown>>(
      k.org_id,
      `INSERT INTO api_keys (id, org_id, created_by, name, prefix, secret_hash, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [k.id, k.org_id, k.created_by, k.name, k.prefix, k.secret_hash, k.scopes, k.expires_at],
    );
    return camelize(r as QueryResultRow) as unknown as ApiKeyRow;
  }
  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL LIMIT 1", [prefix]);
    return r ? (camelize(r) as unknown as ApiKeyRow) : null;
  }
  async touchApiKey(id: string): Promise<void> {
    await this.exec(null, "UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id]);
  }
  async revokeApiKey(orgId: string, id: string): Promise<boolean> {
    const n = await this.exec(orgId, "UPDATE api_keys SET revoked_at = now() WHERE id = $2 AND org_id = $1 AND revoked_at IS NULL", [orgId, id]);
    return (n ?? 0) > 0;
  }
  async listApiKeys(orgId: string): Promise<ApiKeyRow[]> {
    const rows = await this.many<Record<string, unknown>>(orgId, "SELECT * FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC", [orgId]);
    return rows.map((r) => camelize(r) as unknown as ApiKeyRow);
  }

  // ===== projects =====
  async insertProject(p: ProjectRow): Promise<ProjectRow> {
    const r = await this.one<Record<string, unknown>>(
      p.org_id,
      `INSERT INTO projects (id, org_id, created_by, name, description, idea_text, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [p.id, p.org_id, p.created_by, p.name, p.description, p.idea_text, p.language],
    );
    return camelize(r as QueryResultRow) as unknown as ProjectRow;
  }
  async getProject(orgId: string, id: string): Promise<ProjectRow | null> {
    const r = await this.one<Record<string, unknown>>(orgId, "SELECT * FROM projects WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL", [orgId, id]);
    return r ? (camelize(r) as unknown as ProjectRow) : null;
  }
  async listProjects(orgId: string, opts: { q?: string; cursor?: string | null; limit: number }) {
    const cursorTuple = opts.cursor
      ? (Buffer.from(opts.cursor, "base64url").toString("utf8").split("|") as [string, string])
      : null;
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      `SELECT * FROM projects
       WHERE org_id = $1 AND deleted_at IS NULL
         AND ($2::text IS NULL OR name ILIKE '%' || $2::text || '%' OR description ILIKE '%' || $2::text || '%')
         AND ($3::timestamptz IS NULL OR (updated_at, id) < ($3::timestamptz, $4::uuid))
       ORDER BY updated_at DESC, id DESC
       LIMIT $5`,
      [orgId, opts.q ?? null, cursorTuple?.[0] ?? null, cursorTuple?.[1] ?? null, opts.limit + 1],
    );
    const items = rows.slice(0, opts.limit).map((r) => camelize(r) as unknown as ProjectRow);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > opts.limit && last ? Buffer.from(`${last.updated_at}|${last.id}`).toString("base64url") : null };
  }
  async updateProject(orgId: string, id: string, patch: Partial<ProjectRow>): Promise<ProjectRow | null> {
    const r = await this.one<Record<string, unknown>>(
      orgId,
      `UPDATE projects SET
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         language = COALESCE($5, language)
       WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING *`,
      [orgId, id, patch.name ?? null, patch.description ?? null, patch.language ?? null],
    );
    return r ? (camelize(r) as unknown as ProjectRow) : null;
  }
  async softDeleteProject(orgId: string, id: string): Promise<boolean> {
    const n = await this.exec(orgId, "UPDATE projects SET deleted_at = now() WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL", [orgId, id]);
    return (n ?? 0) > 0;
  }
  async projectSummaries(orgId: string, projectIds: string[]) {
    const map = new Map<string, { documents_count: number; latest_run: { id: string; status: string; mode: string; created_at: string } | null }>();
    if (projectIds.length === 0) return map;
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      `SELECT p.id AS project_id,
              (SELECT count(*) FROM documents d WHERE d.org_id = p.org_id AND d.project_id = p.id AND d.deleted_at IS NULL) AS documents_count,
              (SELECT json_build_object('id', r.id, 'status', r.status, 'mode', r.mode, 'created_at', r.created_at)
                 FROM generation_runs r WHERE r.org_id = p.org_id AND r.project_id = p.id
                 ORDER BY r.created_at DESC LIMIT 1) AS latest_run
       FROM projects p WHERE p.org_id = $1 AND p.id = ANY($2::uuid[])`,
      [orgId, projectIds],
    );
    for (const row of rows) {
      map.set(row.project_id as string, {
        documents_count: Number(row.documents_count ?? 0),
        latest_run: (row.latest_run as { id: string; status: string; mode: string; created_at: string } | null) ?? null,
      });
    }
    return map;
  }

  // ===== reference sources =====
  async insertSource(s: SourceRow): Promise<SourceRow> {
    const r = await this.one<Record<string, unknown>>(
      s.org_id,
      `INSERT INTO reference_sources (id, org_id, project_id, url, host, status, attested_by, attested_at, max_pages, stats, crawl_started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [s.id, s.org_id, s.project_id, s.url, s.host, s.status, s.attested_by, s.attested_at, s.max_pages, JSON.stringify(s.stats ?? {}), s.crawl_started_at],
    );
    return camelize(r as QueryResultRow) as unknown as SourceRow;
  }
  async getSource(orgId: string, id: string): Promise<SourceRow | null> {
    const r = await this.one<Record<string, unknown>>(orgId, "SELECT * FROM reference_sources WHERE org_id = $1 AND id = $2", [orgId, id]);
    return r ? (camelize(r) as unknown as SourceRow) : null;
  }
  async getSourceSystem(sourceId: string): Promise<SourceRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM reference_sources WHERE id = $1", [sourceId]);
    return r ? (camelize(r) as unknown as SourceRow) : null;
  }
  async listSourcesByProject(orgId: string, projectId: string): Promise<SourceRow[]> {
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      "SELECT * FROM reference_sources WHERE org_id = $1 AND project_id = $2 ORDER BY created_at DESC",
      [orgId, projectId],
    );
    return rows.map((r) => camelize(r) as unknown as SourceRow);
  }
  async updateSource(orgId: string, id: string, patch: Partial<SourceRow>): Promise<SourceRow | null> {
    const r = await this.one<Record<string, unknown>>(
      orgId,
      `UPDATE reference_sources SET
         status = COALESCE($3, status),
         failure_code = COALESCE($4, failure_code),
         stats = COALESCE($5, stats),
         crawl_started_at = COALESCE($6, crawl_started_at),
         crawl_finished_at = COALESCE($7, crawl_finished_at),
         confirmed_at = COALESCE($8, confirmed_at),
         reuse_until = COALESCE($9, reuse_until)
       WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, id, patch.status ?? null, patch.failure_code ?? null,
       patch.stats ? JSON.stringify(patch.stats) : null,
       patch.crawl_started_at ?? null, patch.crawl_finished_at ?? null,
       patch.confirmed_at ?? null, patch.reuse_until ?? null],
    );
    return r ? (camelize(r) as unknown as SourceRow) : null;
  }
  async insertCrawlPages(rows: CrawlPageRowLite[]): Promise<void> {
    if (rows.length === 0) return;
    await this.tx(null, async (q) => {
      for (const p of rows) {
        await q(
          `INSERT INTO crawl_pages (id, org_id, source_id, url, url_sha256, depth, state, skip_reason, http_status, title, template_cluster, content_sha256, a11y_summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (source_id, url_sha256, created_at) DO NOTHING`,
          [p.id, p.org_id, p.source_id, p.url, Buffer.from(p.url_sha256, "hex"), p.depth, p.state, p.skip_reason, p.http_status, p.title, p.template_cluster,
           p.content_sha256 ? Buffer.from(p.content_sha256, "hex") : null, JSON.stringify(p.a11y_summary ?? {})],
        );
      }
    });
  }
  async listCrawlPages(orgId: string, sourceId: string): Promise<CrawlPageRowLite[]> {
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      "SELECT * FROM crawl_pages WHERE org_id = $1 AND source_id = $2 ORDER BY depth, created_at",
      [orgId, sourceId],
    );
    return rows.map((row) => {
      const c = camelize(row) as Record<string, unknown>;
      return {
        ...c,
        url_sha256: Buffer.from(row.url_sha256 as Buffer).toString("hex"),
        content_sha256: row.content_sha256 ? Buffer.from(row.content_sha256 as Buffer).toString("hex") : null,
      } as unknown as CrawlPageRowLite;
    });
  }
  async upsertDesignExtraction(row: DesignExtractionRow): Promise<DesignExtractionRow> {
    const r = await this.one<Record<string, unknown>>(
      row.org_id,
      `INSERT INTO design_extractions (id, org_id, source_id, tokens, components, information_arch, flows, tech_hints, injection_suspected, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (source_id) DO UPDATE SET
         tokens = EXCLUDED.tokens, components = EXCLUDED.components, information_arch = EXCLUDED.information_arch,
         flows = EXCLUDED.flows, tech_hints = EXCLUDED.tech_hints, injection_suspected = EXCLUDED.injection_suspected,
         model = EXCLUDED.model, updated_at = now()
       RETURNING *`,
      [row.id, row.org_id, row.source_id, JSON.stringify(row.tokens), JSON.stringify(row.components),
       JSON.stringify(row.information_arch), JSON.stringify(row.flows), JSON.stringify(row.tech_hints),
       row.injection_suspected, row.model],
    );
    return camelize(r as QueryResultRow) as unknown as DesignExtractionRow;
  }
  async getDesignExtraction(orgId: string, sourceId: string): Promise<DesignExtractionRow | null> {
    const r = await this.one<Record<string, unknown>>(orgId, "SELECT * FROM design_extractions WHERE org_id = $1 AND source_id = $2", [orgId, sourceId]);
    return r ? (camelize(r) as unknown as DesignExtractionRow) : null;
  }

  // ===== runs & stages =====
  async createRunWithReservation(run: RunRow, stages: StageRow[], cost: number): Promise<RunRow> {
    return this.tx(run.org_id, async (q) => {
      // Reserve-then-settle: atomic conditional UPDATE in the same transaction as the run insert (TRD D2).
      const res = await q(
        `UPDATE credit_accounts SET reserved = reserved + $2, updated_at = now()
         WHERE org_id = $1 AND (balance - reserved) >= $2 RETURNING balance, reserved`,
        [run.org_id, cost],
      );
      if (res.rowCount === 0) {
        const acct = await q("SELECT balance, reserved FROM credit_accounts WHERE org_id = $1", [run.org_id]);
        const bal = Number(acct.rows[0]?.balance ?? 0);
        const reserved = Number(acct.rows[0]?.reserved ?? 0);
        throw new InsufficientCredits(cost, r2(bal - reserved));
      }
      const acc = res.rows[0];
      await q(
        `INSERT INTO generation_runs (id, org_id, project_id, source_id, created_by, mode, status, input, language, doc_types, glossary,
           credit_cost, credits_reserved, max_input_tokens, max_output_tokens, max_repair_attempts, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, CASE WHEN $7 = 'running' THEN now() ELSE NULL END)`,
        [run.id, run.org_id, run.project_id, run.source_id, run.created_by, run.mode, run.status,
         JSON.stringify(run.input ?? {}), run.language, run.doc_types, JSON.stringify(run.glossary ?? {}),
         run.credit_cost, cost, run.max_input_tokens, run.max_output_tokens, run.max_repair_attempts],
      );
      await q(
        `INSERT INTO usage_ledger (org_id, entry_type, amount, run_id, ledger_key, balance_after, reserved_after, metadata)
         VALUES ($1,'reserve',$2,$3,$4,$5,$6,'{}'::jsonb)`,
        [run.org_id, cost, run.id, `reserve:${run.id}`, Number(acc.balance), Number(acc.reserved)],
      );
      for (const s of stages) {
        await q(
          `INSERT INTO run_stages (id, org_id, run_id, stage, status)
           VALUES ($1,$2,$3,$4,$5)`,
          [s.id, s.org_id, s.run_id, s.stage, s.status],
        );
      }
      return run;
    });
  }
  async getRun(orgId: string, id: string): Promise<RunRow | null> {
    const r = await this.one<Record<string, unknown>>(orgId, "SELECT * FROM generation_runs WHERE org_id = $1 AND id = $2", [orgId, id]);
    return r ? this.runFromRow(r) : null;
  }
  async getRunSystem(runId: string): Promise<RunRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM generation_runs WHERE id = $1", [runId]);
    return r ? this.runFromRow(r) : null;
  }
  private runFromRow(r: Record<string, unknown>): RunRow {
    const c = camelize(r) as Record<string, unknown>;
    return {
      ...(c as unknown as RunRow),
      input: typeof r.input === "string" ? JSON.parse(r.input as string) : ((r.input as RunRow["input"]) ?? {}),
      glossary: typeof r.glossary === "string" ? JSON.parse(r.glossary as string) : ((r.glossary as RunRow["glossary"]) ?? { canonical: {}, entities: [] }),
      doc_types: (r.doc_types as string[]) as RunRow["doc_types"],
    };
  }
  async listRunsByProject(orgId: string, projectId: string, limit: number): Promise<RunRow[]> {
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      "SELECT * FROM generation_runs WHERE org_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT $3",
      [orgId, projectId, limit],
    );
    return rows.map((r) => this.runFromRow(r));
  }
  async updateRun(orgId: string, id: string, patch: Partial<RunRow>): Promise<RunRow | null> {
    const r = await this.one<Record<string, unknown>>(
      orgId,
      `UPDATE generation_runs SET
         status = COALESCE($3, status),
         input = COALESCE($4, input),
         language = COALESCE($5, language),
         glossary = COALESCE($6, glossary),
         credits_settled = COALESCE($7, credits_settled),
         tokens_in = COALESCE($8, tokens_in),
         tokens_out = COALESCE($9, tokens_out),
         llm_calls = COALESCE($10, llm_calls),
         injection_suspected = COALESCE($11, injection_suspected),
         cancel_requested_at = COALESCE($12, cancel_requested_at),
         error_code = $13,
         started_at = COALESCE($14, started_at),
         finished_at = COALESCE($15, finished_at),
         credits_reserved = COALESCE($16, credits_reserved)
       WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, id, patch.status ?? null, patch.input ? JSON.stringify(patch.input) : null, patch.language ?? null,
       patch.glossary ? JSON.stringify(patch.glossary) : null, patch.credits_settled ?? null,
       patch.tokens_in ?? null, patch.tokens_out ?? null, patch.llm_calls ?? null,
       patch.injection_suspected ?? null, patch.cancel_requested_at ?? null, patch.error_code ?? null,
       patch.started_at ?? null, patch.finished_at ?? null, patch.credits_reserved ?? null],
    );
    return r ? this.runFromRow(r) : null;
  }
  async updateRunSystem(runId: string, patch: Partial<RunRow>): Promise<RunRow | null> {
    // system-level updates for workers (reaper/finalizer semantics)
    const run = await this.getRunSystem(runId);
    if (!run) return null;
    return this.updateRun(run.org_id, runId, patch);
  }
  async countActiveRuns(orgId: string): Promise<number> {
    const r = await this.one<Record<string, unknown>>(
      orgId,
      "SELECT count(*) AS n FROM generation_runs WHERE org_id = $1 AND status IN ('queued','running','paused_provider')",
      [orgId],
    );
    return Number(r?.n ?? 0);
  }
  async listOpenRunIds(): Promise<string[]> {
    const rows = await this.many<Record<string, unknown>>(
      null,
      "SELECT id FROM generation_runs WHERE status IN ('queued','running','paused_provider') ORDER BY created_at",
    );
    return rows.map((r) => r.id as string);
  }

  async listStages(orgId: string, runId: string): Promise<StageRow[]> {
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      "SELECT * FROM run_stages WHERE org_id = $1 AND run_id = $2 ORDER BY queued_at",
      [orgId, runId],
    );
    return rows.map((r) => this.stageFromRow(r));
  }
  async listStagesSystem(runId: string): Promise<StageRow[]> {
    const rows = await this.many<Record<string, unknown>>(null, "SELECT * FROM run_stages WHERE run_id = $1 ORDER BY queued_at", [runId]);
    return rows.map((r) => this.stageFromRow(r));
  }
  private stageFromRow(r: Record<string, unknown>): StageRow {
    const c = camelize(r) as Record<string, unknown>;
    return {
      ...(c as unknown as StageRow),
      output_ref: typeof r.output_ref === "string" ? JSON.parse(r.output_ref as string) : ((r.output_ref as Record<string, unknown>) ?? {}),
    };
  }
  async claimStage(orgId: string, runId: string, stage: StageName, owner: string, leaseSeconds: number): Promise<StageRow | null> {
    const r = await this.one<Record<string, unknown>>(
      orgId,
      `UPDATE run_stages SET status='running', lease_owner=$4, lease_expires_at=now() + ($5 || ' seconds')::interval,
         attempt=attempt+1, started_at=COALESCE(started_at, now()), updated_at=now()
       WHERE org_id=$1 AND run_id=$2 AND stage=$3
         AND status IN ('queued','retry_wait')
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         AND (lease_expires_at IS NULL OR lease_expires_at < now())
       RETURNING *`,
      [orgId, runId, stage, owner, String(leaseSeconds)],
    );
    return r ? this.stageFromRow(r) : null;
  }
  async heartbeatStage(orgId: string, stageId: string, owner: string, leaseSeconds: number): Promise<boolean> {
    const n = await this.exec(
      orgId,
      `UPDATE run_stages SET lease_expires_at = now() + ($4 || ' seconds')::interval
       WHERE org_id = $1 AND id = $2 AND lease_owner = $3 AND status = 'running'`,
      [orgId, stageId, owner, String(leaseSeconds)],
    );
    return (n ?? 0) > 0;
  }
  async completeStageSucceeded(
    orgId: string, runId: string, stage: StageName, attempt: number,
    stagePatch: { output_ref: Record<string, unknown>; tokens_in: number; tokens_out: number; credits_settled: number; provider: string | null; model: string | null },
    opts: {
      ledger: { amount: number; ledger_key: string; entry_type: LedgerEntryType };
      runPatch?: Partial<RunRow>;
      documents?: { doc: DocumentRow; version: DocumentVersionRow; sections: Omit<DocumentSectionRow, "org_id" | "version_id" | "created_at" | "updated_at">[] }[];
    },
  ): Promise<boolean> {
    return this.tx(orgId, async (q) => {
      // Exactly-once: only the transaction that wins the conditional transition settles (TRD D1).
      const win = await q(
        `UPDATE run_stages SET status='succeeded', finished_at=now(), lease_owner=NULL, lease_expires_at=NULL,
           output_ref=$5, tokens_in=$6, tokens_out=$7, credits_settled=$8, provider=$9, model=$10, updated_at=now()
         WHERE org_id=$1 AND run_id=$2 AND stage=$3 AND status='running' AND attempt=$4 RETURNING id`,
        [orgId, runId, stage, attempt, JSON.stringify(stagePatch.output_ref),
         stagePatch.tokens_in, stagePatch.tokens_out, stagePatch.credits_settled, stagePatch.provider, stagePatch.model],
      );
      if (win.rowCount === 0) return false;

      for (const d of opts.documents ?? []) {
        await q(
          `INSERT INTO documents (id, org_id, project_id, run_id, doc_type, title, current_version_id, latest_version_no)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
          [d.doc.id, orgId, d.doc.project_id, runId, d.doc.doc_type, d.doc.title, d.version.id],
        );
        await q(
          `INSERT INTO document_versions (id, org_id, document_id, version_no, author_type, author_id, change_note, content_md, content_sha256, sections_count, model, tokens_in, tokens_out)
           VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [d.version.id, orgId, d.doc.id, d.version.author_type, d.version.author_id, d.version.change_note,
           d.version.content_md, Buffer.from(d.version.content_sha256, "hex"), d.version.sections_count,
           stagePatch.model, stagePatch.tokens_in, stagePatch.tokens_out],
        );
        for (const s of d.sections) {
          await q(
            `INSERT INTO document_sections (id, org_id, version_id, ordinal, anchor, heading, body_md, status, error_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [s.id, orgId, d.version.id, s.ordinal, s.anchor, s.heading, s.body_md, s.status ?? "done", s.error_code ?? null],
          );
        }
      }

      if (opts.ledger.amount > 0) {
        const acc = await q(
          `UPDATE credit_accounts SET balance = balance - $2, reserved = GREATEST(0, reserved - $2), updated_at = now()
           WHERE org_id = $1 RETURNING balance, reserved`,
          [orgId, opts.ledger.amount],
        );
        const row = acc.rows[0] as { balance: string; reserved: string } | undefined;
        await q(
          `INSERT INTO usage_ledger (org_id, entry_type, amount, run_id, stage, ledger_key, balance_after, reserved_after, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [orgId, opts.ledger.entry_type, opts.ledger.amount, runId, stage, opts.ledger.ledger_key,
           Number(row?.balance ?? 0), Number(row?.reserved ?? 0), JSON.stringify({ attempt })],
        );
      }

      const rp = opts.runPatch ?? {};
      await q(
        `UPDATE generation_runs SET
           tokens_in = tokens_in + $3, tokens_out = tokens_out + $4, llm_calls = llm_calls + 1,
           credits_settled = credits_settled + $5,
           input = COALESCE($6, input), language = COALESCE($7, language), glossary = COALESCE($8, glossary),
           injection_suspected = COALESCE($9, injection_suspected),
           status = COALESCE($10, status), started_at = COALESCE($11, started_at),
           finished_at = COALESCE($12, finished_at), credits_reserved = COALESCE($13, credits_reserved),
           updated_at = now()
         WHERE org_id = $1 AND id = $2`,
        [orgId, runId, stagePatch.tokens_in, stagePatch.tokens_out, stagePatch.credits_settled,
         rp.input ? JSON.stringify(rp.input) : null, rp.language ?? null, rp.glossary ? JSON.stringify(rp.glossary) : null,
         rp.injection_suspected ?? null, rp.status ?? null, rp.started_at ?? null, rp.finished_at ?? null, rp.credits_reserved ?? null],
      );
      return true;
    });
  }
  async failStageAttempt(
    orgId: string, runId: string, stage: StageName, attempt: number,
    errorCode: string, errorDetail: string, nextAttemptAt: string | null, releaseReserved: number,
  ): Promise<boolean> {
    return this.tx(orgId, async (q) => {
      const win = await q(
        `UPDATE run_stages SET status = CASE WHEN $5::timestamptz IS NULL THEN 'failed' ELSE 'retry_wait' END,
           error_code=$6, error_detail=$7, next_attempt_at=$5, lease_owner=NULL, lease_expires_at=NULL,
           finished_at = CASE WHEN $5::timestamptz IS NULL THEN now() ELSE NULL END, updated_at=now()
         WHERE org_id=$1 AND run_id=$2 AND stage=$3 AND status='running' AND attempt=$4 RETURNING id`,
        [orgId, runId, stage, attempt, nextAttemptAt, errorCode, errorDetail],
      );
      if (win.rowCount === 0) return false;
      if (releaseReserved > 0) {
        const acc = await q(
          `UPDATE credit_accounts SET reserved = GREATEST(0, reserved - $2), updated_at = now() WHERE org_id = $1 RETURNING balance, reserved`,
          [orgId, releaseReserved],
        );
        const row = acc.rows[0] as { balance: string; reserved: string } | undefined;
        await q(
          `INSERT INTO usage_ledger (org_id, entry_type, amount, run_id, stage, ledger_key, balance_after, reserved_after, metadata)
           VALUES ($1,'release',$2,$3,$4,$5,$6,$7,$8)`,
          [orgId, releaseReserved, runId, stage, `release:${runId}:${stage}:${attempt}`, Number(row?.balance ?? 0), Number(row?.reserved ?? 0), JSON.stringify({ reason: errorCode })],
        );
      }
      return true;
    });
  }

  async resetStageForRetry(orgId: string, runId: string, stage: StageName): Promise<boolean> {
    const n = await this.exec(
      orgId,
      `UPDATE run_stages SET status='queued', next_attempt_at=NULL, error_code=NULL, error_detail=NULL,
         finished_at=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE org_id=$1 AND run_id=$2 AND stage=$3 AND status='failed'`,
      [orgId, runId, stage],
    );
    return (n ?? 0) > 0;
  }

  // ===== documents, versions, sections =====
  async getDocument(orgId: string, id: string): Promise<DocumentRow | null> {
    const r = await this.one<Record<string, unknown>>(orgId, "SELECT * FROM documents WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL", [orgId, id]);
    return r ? (camelize(r) as unknown as DocumentRow) : null;
  }
  async listDocumentsByProject(orgId: string, projectId: string): Promise<DocumentRow[]> {
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      "SELECT * FROM documents WHERE org_id = $1 AND project_id = $2 AND deleted_at IS NULL ORDER BY created_at",
      [orgId, projectId],
    );
    return rows.map((r) => camelize(r) as unknown as DocumentRow);
  }
  async getDocumentVersion(orgId: string, documentId: string, versionNo: number | "current"): Promise<NewVersionResult | null> {
    return this.tx(orgId, async (q) => {
      const doc = await q("SELECT * FROM documents WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL", [orgId, documentId]);
      if (doc.rowCount === 0) return null;
      const v = versionNo === "current"
        ? await q("SELECT * FROM document_versions WHERE org_id = $1 AND id = $2", [orgId, (doc.rows[0] as { current_version_id: string }).current_version_id])
        : await q("SELECT * FROM document_versions WHERE org_id = $1 AND document_id = $2 AND version_no = $3", [orgId, documentId, versionNo]);
      if (v.rowCount === 0) return null;
      const version = camelize(v.rows[0]) as unknown as DocumentVersionRow;
      version.content_sha256 = Buffer.from(v.rows[0].content_sha256 as Buffer).toString("hex");
      const sections = (await q("SELECT * FROM document_sections WHERE org_id = $1 AND version_id = $2 ORDER BY ordinal", [orgId, version.id])).rows
        .map((r) => camelize(r) as unknown as DocumentSectionRow);
      return { version, sections };
    });
  }
  async listVersions(orgId: string, documentId: string): Promise<DocumentVersionRow[]> {
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      "SELECT * FROM document_versions WHERE org_id = $1 AND document_id = $2 ORDER BY version_no DESC",
      [orgId, documentId],
    );
    return rows.map((r) => {
      const v = camelize(r) as unknown as DocumentVersionRow;
      v.content_sha256 = Buffer.from(r.content_sha256 as Buffer).toString("hex");
      return v;
    });
  }
  async createNewVersion(
    orgId: string, documentId: string, baseVersionNo: number, edits: Map<string, string>,
    opts: { changeNote: string | null; authorId: string | null; authorType: "ai" | "user"; model?: string | null; ledger?: { amount: number; ledger_key: string } },
  ): Promise<CreateVersionOutcome> {
    return this.tx(orgId, async (q) => {
      const docRes = await q("SELECT * FROM documents WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE", [orgId, documentId]);
      if (docRes.rowCount === 0) return "CONFLICT";
      const doc = docRes.rows[0] as { latest_version_no: number; run_id: string | null };
      if (doc.latest_version_no !== baseVersionNo) return "CONFLICT";

      const curRes = await q(
        "SELECT * FROM document_versions WHERE org_id = $1 AND id = $2",
        [orgId, (docRes.rows[0] as { current_version_id: string }).current_version_id],
      );
      if (curRes.rowCount === 0) return "CONFLICT";
      const currentVersionId = (curRes.rows[0] as { id: string }).id;
      const currentSections = (await q("SELECT * FROM document_sections WHERE org_id = $1 AND version_id = $2 ORDER BY ordinal", [orgId, currentVersionId])).rows as QueryResultRow[];

      if (opts.ledger && opts.ledger.amount > 0) {
        const res = await q(
          `UPDATE credit_accounts SET reserved = reserved + $2 WHERE org_id = $1 AND (balance - reserved) >= $2 RETURNING balance, reserved`,
          [orgId, opts.ledger.amount],
        );
        if (res.rowCount === 0) throw new InsufficientCredits(opts.ledger.amount, 0);
      }

      const newVersionId = uuidv7();
      const newVersionNo = doc.latest_version_no + 1;
      let fullMd = "";
      await q(
        `INSERT INTO document_versions (id, org_id, document_id, version_no, author_type, author_id, change_note, content_md, content_sha256, sections_count, model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'',decode('','hex'),0,$8)`,
        [newVersionId, orgId, documentId, newVersionNo, opts.authorType, opts.authorId, opts.changeNote, opts.model ?? null],
      );
      const newSections: DocumentSectionRow[] = [];
      const now = nowIso();
      for (const s of currentSections) {
        const body = edits.get(s.id as string) ?? (s.body_md as string);
        fullMd += `## ${s.heading as string}\n\n${body}\n\n`;
        const secId = uuidv7();
        await q(
          `INSERT INTO document_sections (id, org_id, version_id, ordinal, anchor, heading, body_md, status, error_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'done',NULL)`,
          [secId, orgId, newVersionId, s.ordinal, s.anchor, s.heading, body],
        );
        newSections.push({
          id: secId, org_id: orgId, version_id: newVersionId, ordinal: s.ordinal as number,
          anchor: s.anchor as string, heading: s.heading as string, body_md: body,
          status: "done", error_code: null, created_at: now, updated_at: now,
        });
      }
      const sha = Buffer.from(fullMd).toString("hex").slice(0, 64);
      await q(
        `UPDATE document_versions SET content_md = $3, content_sha256 = $4, sections_count = $5 WHERE org_id = $1 AND id = $2`,
        [orgId, newVersionId, fullMd, Buffer.from(sha, "hex"), newSections.length],
      );
      await q(
        `UPDATE documents SET current_version_id = $3, latest_version_no = $4, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [orgId, documentId, newVersionId, newVersionNo],
      );
      if (opts.ledger && opts.ledger.amount > 0) {
        const acc = await q(
          `UPDATE credit_accounts SET balance = balance - $2, reserved = GREATEST(0, reserved - $2), updated_at = now() WHERE org_id = $1 RETURNING balance, reserved`,
          [orgId, opts.ledger.amount],
        );
        const row = acc.rows[0] as { balance: string; reserved: string } | undefined;
        await q(
          `INSERT INTO usage_ledger (org_id, entry_type, amount, run_id, stage, ledger_key, balance_after, reserved_after, metadata)
           VALUES ($1,'settle',$2,$3,'REGEN',$4,$5,$6,$7)`,
          [orgId, opts.ledger.amount, doc.run_id, opts.ledger.ledger_key, Number(row?.balance ?? 0), Number(row?.reserved ?? 0), JSON.stringify({ document_id: documentId })],
        );
      }
      const version: DocumentVersionRow = {
        id: newVersionId, org_id: orgId, document_id: documentId, version_no: newVersionNo,
        author_type: opts.authorType, author_id: opts.authorId, change_note: opts.changeNote,
        content_md: fullMd, content_sha256: sha, sections_count: newSections.length,
        model: opts.model ?? null, tokens_in: 0, tokens_out: 0, created_at: now,
      };
      return { version, sections: newSections };
    });
  }
  async getSectionWithDocument(orgId: string, sectionId: string) {
    return this.tx(orgId, async (q) => {
      const sec = await q("SELECT * FROM document_sections WHERE org_id = $1 AND id = $2", [orgId, sectionId]);
      if (sec.rowCount === 0) return null;
      const section = camelize(sec.rows[0]) as unknown as DocumentSectionRow;
      const ver = await q("SELECT * FROM document_versions WHERE org_id = $1 AND id = $2", [orgId, section.version_id]);
      if (ver.rowCount === 0) return null;
      const version = camelize(ver.rows[0]) as unknown as DocumentVersionRow;
      version.content_sha256 = Buffer.from(ver.rows[0].content_sha256 as Buffer).toString("hex");
      const docRes = await q("SELECT * FROM documents WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL", [orgId, version.document_id]);
      if (docRes.rowCount === 0) return null;
      const document = camelize(docRes.rows[0]) as unknown as DocumentRow;
      return { section, version, document };
    });
  }

  // ===== exports =====
  async insertExport(e: ExportRow): Promise<ExportRow> {
    const r = await this.one<Record<string, unknown>>(
      e.org_id,
      `INSERT INTO exports (id, org_id, document_id, run_id, requested_by, format, status, s3_key, size_bytes, error_code, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [e.id, e.org_id, e.document_id, e.run_id, e.requested_by, e.format, e.status, e.s3_key, e.size_bytes, e.error_code, e.expires_at],
    );
    return camelize(r as QueryResultRow) as unknown as ExportRow;
  }
  async getExport(orgId: string, id: string): Promise<ExportRow | null> {
    const r = await this.one<Record<string, unknown>>(orgId, "SELECT * FROM exports WHERE org_id = $1 AND id = $2", [orgId, id]);
    return r ? (camelize(r) as unknown as ExportRow) : null;
  }
  async updateExport(orgId: string, id: string, patch: Partial<ExportRow>): Promise<ExportRow | null> {
    const r = await this.one<Record<string, unknown>>(
      orgId,
      `UPDATE exports SET status = COALESCE($3, status), s3_key = COALESCE($4, s3_key), size_bytes = COALESCE($5, size_bytes),
         error_code = $6, expires_at = COALESCE($7, expires_at)
       WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, id, patch.status ?? null, patch.s3_key ?? null, patch.size_bytes ?? null, patch.error_code ?? null, patch.expires_at ?? null],
    );
    return r ? (camelize(r) as unknown as ExportRow) : null;
  }

  // ===== share links =====
  async insertShareLink(s: ShareLinkRow): Promise<ShareLinkRow> {
    const r = await this.one<Record<string, unknown>>(
      s.org_id,
      `INSERT INTO share_links (id, org_id, document_id, created_by, token_hash, password_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [s.id, s.org_id, s.document_id, s.created_by, Buffer.from(s.token_hash, "hex"), s.password_hash, s.expires_at],
    );
    return camelize(r as QueryResultRow) as unknown as ShareLinkRow;
  }
  async findShareLinkByTokenHash(tokenHash: string): Promise<{ link: ShareLinkRow; document: DocumentRow } | null> {
    return this.tx(null, async (q) => {
      const res = await q("SELECT * FROM share_links WHERE token_hash = $1 LIMIT 1", [Buffer.from(tokenHash, "hex")]);
      if (res.rowCount === 0) return null;
      const link = camelize(res.rows[0]) as unknown as ShareLinkRow;
      const docRes = await q("SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL", [link.document_id]);
      if (docRes.rowCount === 0) return null;
      return { link, document: camelize(docRes.rows[0]) as unknown as DocumentRow };
    });
  }
  async revokeShareLink(orgId: string, id: string): Promise<boolean> {
    const n = await this.exec(orgId, "UPDATE share_links SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL", [orgId, id]);
    return (n ?? 0) > 0;
  }
  async touchShareView(orgId: string, id: string): Promise<void> {
    await this.exec(null, "UPDATE share_links SET view_count = view_count + 1, last_viewed_at = now() WHERE id = $1", [id]);
  }

  // ===== idempotency =====
  async getIdempotency(orgId: string, idemKey: string): Promise<IdempotencyRow | null> {
    const r = await this.one<Record<string, unknown>>(orgId, "SELECT * FROM idempotency_keys WHERE org_id = $1 AND idem_key = $2", [orgId, idemKey]);
    if (!r) return null;
    const c = camelize(r) as Record<string, unknown>;
    return {
      ...(c as unknown as IdempotencyRow),
      response_body: r.response_body ?? null,
    };
  }
  async insertIdempotencyInProgress(row: IdempotencyRow): Promise<boolean> {
    const n = await this.exec(
      row.org_id,
      `INSERT INTO idempotency_keys (id, org_id, idem_key, method, path, request_hash, state, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, idem_key) DO NOTHING`,
      [row.id, row.org_id, row.idem_key, row.method, row.path, Buffer.from(row.request_hash, "hex"), row.state, row.expires_at],
    );
    return (n ?? 0) > 0;
  }
  async completeIdempotency(orgId: string, idemKey: string, status: number, body: unknown): Promise<void> {
    await this.exec(
      orgId,
      `UPDATE idempotency_keys SET state='completed', response_status=$3, response_body=$4 WHERE org_id = $1 AND idem_key = $2`,
      [orgId, idemKey, status, body === undefined ? null : JSON.stringify(body)],
    );
  }

  // ===== credits ledger =====
  async getCreditAccount(orgId: string): Promise<CreditAccountRow> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM credit_accounts WHERE org_id = $1", [orgId]);
    if (r) return camelize(r) as unknown as CreditAccountRow;
    const created = await this.one<Record<string, unknown>>(
      null,
      `INSERT INTO credit_accounts (org_id) VALUES ($1) ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id RETURNING *`,
      [orgId],
    );
    return camelize(created as QueryResultRow) as unknown as CreditAccountRow;
  }
  async reserveCredits(orgId: string, amount: number): Promise<{ balance: number; reserved: number }> {
    const r = await this.one<{ balance: string; reserved: string }>(
      orgId,
      `UPDATE credit_accounts SET reserved = reserved + $2, updated_at = now()
       WHERE org_id = $1 AND (balance - reserved) >= $2 RETURNING balance, reserved`,
      [orgId, amount],
    );
    if (!r) {
      const acct = await this.getCreditAccount(orgId);
      throw new InsufficientCredits(amount, r2(Number(acct.balance) - Number(acct.reserved)));
    }
    return { balance: Number(r.balance), reserved: Number(r.reserved) };
  }
  async releaseCredits(orgId: string, runId: string | null, amount: number, ledgerKey: string, stage?: string): Promise<void> {
    if (amount <= 0) return;
    await this.tx(orgId, async (q) => {
      const acc = await q(
        `UPDATE credit_accounts SET reserved = GREATEST(0, reserved - $2), updated_at = now() WHERE org_id = $1 RETURNING balance, reserved`,
        [orgId, amount],
      );
      const row = acc.rows[0] as { balance: string; reserved: string } | undefined;
      await q(
        `INSERT INTO usage_ledger (org_id, entry_type, amount, run_id, stage, ledger_key, balance_after, reserved_after, metadata)
         VALUES ($1,'release',$2,$3,$4,$5,$6,$7,'{}'::jsonb)`,
        [orgId, amount, runId, stage ?? null, ledgerKey, Number(row?.balance ?? 0), Number(row?.reserved ?? 0)],
      );
    });
  }
  async grantCredits(orgId: string, amount: number, ledgerKey: string, meta: Record<string, unknown>): Promise<boolean> {
    return this.tx(null, async (q) => {
      const dup = await q(`SELECT 1 FROM usage_ledger WHERE org_id = $1 AND ledger_key = $2 LIMIT 1`, [orgId, ledgerKey]);
      if (dup.rowCount && dup.rowCount > 0) return false;
      const acc = await q(
        `UPDATE credit_accounts SET balance = balance + $2, updated_at = now() WHERE org_id = $1 RETURNING balance, reserved`,
        [orgId, amount],
      );
      const row = acc.rows[0] as { balance: string; reserved: string } | undefined;
      await q(
        `INSERT INTO usage_ledger (org_id, entry_type, amount, ledger_key, balance_after, reserved_after, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, (meta.entry_type as string) ?? "grant", amount, ledgerKey, Number(row?.balance ?? 0), Number(row?.reserved ?? 0), JSON.stringify(meta)],
      );
      return true;
    });
  }
  async listLedger(orgId: string, limit: number): Promise<LedgerRow[]> {
    const rows = await this.many<Record<string, unknown>>(
      orgId,
      "SELECT * FROM usage_ledger WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2",
      [orgId, limit],
    );
    return rows.map((r) => camelize(r) as unknown as LedgerRow);
  }

  // ===== subscriptions & webhooks =====
  async upsertSubscription(s: SubscriptionRow): Promise<SubscriptionRow> {
    const r = await this.one<Record<string, unknown>>(
      null,
      `INSERT INTO subscriptions (id, org_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, last_event_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id) DO UPDATE SET
         stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
         plan = EXCLUDED.plan, status = EXCLUDED.status, current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
         last_event_at = EXCLUDED.last_event_at, updated_at = now()
       RETURNING *`,
      [s.id, s.org_id, s.stripe_customer_id, s.stripe_subscription_id, s.plan, s.status, s.current_period_end, s.last_event_at],
    );
    return camelize(r as QueryResultRow) as unknown as SubscriptionRow;
  }
  async getSubscription(orgId: string): Promise<SubscriptionRow | null> {
    const r = await this.one<Record<string, unknown>>(null, "SELECT * FROM subscriptions WHERE org_id = $1", [orgId]);
    return r ? (camelize(r) as unknown as SubscriptionRow) : null;
  }
  async insertWebhookEvent(w: WebhookEventRow): Promise<boolean> {
    const n = await this.exec(
      null,
      `INSERT INTO webhook_events (id, provider, provider_event_id, event_type, payload, status)
       VALUES ($1,$2,$3,$4,$5,'received')
       ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [w.id, w.provider, w.provider_event_id, w.event_type, JSON.stringify(w.payload ?? {})],
    );
    return (n ?? 0) > 0;
  }
  async updateWebhookEvent(id: string, patch: Partial<WebhookEventRow>): Promise<void> {
    await this.exec(
      null,
      `UPDATE webhook_events SET status = COALESCE($2, status), attempts = COALESCE($3, attempts), error = $4, processed_at = COALESCE($5, processed_at) WHERE id = $1`,
      [id, patch.status ?? null, patch.attempts ?? null, patch.error ?? null, patch.processed_at ?? null],
    );
  }
  async updateWebhookEventByProviderId(providerEventId: string, patch: Partial<WebhookEventRow>): Promise<void> {
    await this.exec(
      null,
      `UPDATE webhook_events SET status = COALESCE($2, status), attempts = COALESCE($3, attempts), error = $4, processed_at = COALESCE($5, processed_at) WHERE provider_event_id = $1`,
      [providerEventId, patch.status ?? null, patch.attempts ?? null, patch.error ?? null, patch.processed_at ?? null],
    );
  }

  // ===== outbox, audit, failed jobs =====
  async emitOutbox(rows: Omit<OutboxEventRow, "status" | "attempts" | "published_at">[]): Promise<void> {
    if (rows.length === 0) return;
    await this.tx(null, async (q) => {
      for (const row of rows) {
        await q(
          `INSERT INTO outbox_events (id, org_id, aggregate_type, aggregate_id, event_type, payload, trace_context, status, attempts, available_at, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'published',1,$8,now())`,
          [row.id, row.org_id, row.aggregate_type, row.aggregate_id, row.event_type, JSON.stringify(row.payload ?? {}), row.trace_context, row.available_at],
        );
      }
    });
  }
  async writeAudit(rows: Omit<AuditRow, "id">[]): Promise<void> {
    if (rows.length === 0) return;
    await this.tx(null, async (q) => {
      for (const row of rows) {
        await q(
          `INSERT INTO audit_logs (org_id, actor_user_id, actor_type, action, resource_type, resource_id, ip, user_agent, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [row.org_id, row.actor_user_id, row.actor_type, row.action, row.resource_type, row.resource_id, row.ip, row.user_agent, JSON.stringify(row.metadata ?? {})],
        );
      }
    });
  }
  async recordFailedJob(row: Omit<import("../types.js").FailedJobRow, "id" | "created_at" | "updated_at">): Promise<void> {
    await this.exec(
      null,
      `INSERT INTO failed_jobs (org_id, queue, message_id, run_id, stage, error, payload, receive_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (queue, message_id) DO UPDATE SET receive_count = failed_jobs.receive_count + 1, updated_at = now()`,
      [row.org_id, row.queue, row.message_id, row.run_id, row.stage, row.error, JSON.stringify(row.payload ?? {}), row.receive_count],
    );
  }

  // ===== GDPR =====
  async exportUserData(orgId: string, _userId: string): Promise<Record<string, unknown>> {
    const projects = await this.many<Record<string, unknown>>(orgId, "SELECT * FROM projects WHERE org_id = $1", [orgId]);
    const documents = await this.many<Record<string, unknown>>(orgId, "SELECT * FROM documents WHERE org_id = $1", [orgId]);
    const ledger = await this.many<Record<string, unknown>>(orgId, "SELECT * FROM usage_ledger WHERE org_id = $1 ORDER BY created_at DESC LIMIT 500", [orgId]);
    return { exported_at: nowIso(), org_id: orgId, projects, documents, ledger };
  }
  async deleteOrgData(orgId: string): Promise<void> {
    await this.exec(orgId, "UPDATE projects SET deleted_at = now() WHERE org_id = $1", [orgId]);
    await this.exec(orgId, "UPDATE documents SET deleted_at = now() WHERE org_id = $1", [orgId]);
    await this.exec(null, "UPDATE organizations SET deleted_at = now(), name = 'deleted-' || id::text WHERE id = $1", [orgId]);
  }
}
