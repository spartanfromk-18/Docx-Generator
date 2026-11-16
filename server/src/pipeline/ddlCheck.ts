/**
 * Executes generated DDL against an ephemeral Postgres schema (SCHEMA_VALIDATE
 * production path). Memory mode never imports this; postgres mode calls it once
 * per SCHEMA_VALIDATE stage. The schema is dropped in a finally block.
 */
import pg from "pg";
import { env } from "../env.js";
import { slugify } from "../util.js";

export async function execDdlInEphemeralSchema(sql: string): Promise<{ errors: string[] }> {
  const schemaName = `specforge_check_${slugify(String(Date.now()))}_${process.pid}`;
  const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  const errors: string[] = [];
  try {
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
      await client.query(`SET LOCAL search_path = "${schemaName}", public`);
      // uuid_v7 may not exist when validating against a bare database — stub it for the check.
      await client.query(
        `CREATE OR REPLACE FUNCTION "${schemaName}".uuid_v7() RETURNS uuid LANGUAGE sql AS $fn$ SELECT gen_random_uuid() $fn$`,
      );
      const statements = sql
        .split(/;\s*(?=\n|$)/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        try {
          await client.query(stmt.replace(/uuid_v7\(\)/g, `"${schemaName}".uuid_v7()`));
        } catch (err) {
          errors.push(`DDL error: ${(err as Error).message.slice(0, 200)}`);
        }
      }
    } finally {
      client.release();
    }
  } catch (err) {
    errors.push(`Ephemeral schema setup failed: ${(err as Error).message.slice(0, 200)}`);
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } catch {
      /* best effort cleanup */
    }
    await pool.end().catch(() => undefined);
  }
  return { errors };
}
