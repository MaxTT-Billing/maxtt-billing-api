// routes/system.js (ESM) — self-test + migration + schema debug

import pkg from "pg";
import { runSelfTest } from "../src/selftest.js";

const { Pool } = pkg;

export default function systemRouter(app) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // ===== Existing self-test (kept) =====
  app.get("/__db/installations-selftest", async (req, res) => {
    try {
      const report = await runSelfTest(pool);
      res.status(200).json({ ok: true, report });
    } catch (err) {
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // ===== One-time migration (kept) =====
  async function applyMigration(client) {
    const steps = [];
    const push = (name, ok, details = null) => steps.push({ name, ok, details });

    const stmts = [
      `
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      `,
      `
      CREATE TABLE IF NOT EXISTS installations (
        id BIGSERIAL PRIMARY KEY,
        franchisee_id TEXT NOT NULL,
        stock_check_litres_snapshot NUMERIC(10,2) NOT NULL,
        stock_check_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        allowed_to_proceed BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','completed','cancelled')),
        used_litres NUMERIC(10,2),
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      `,
      `CREATE INDEX IF NOT EXISTS idx_installations_franchisee ON installations (franchisee_id);`,
      `CREATE INDEX IF NOT EXISTS idx_installations_status ON installations (status);`,
      `CREATE INDEX IF NOT EXISTS idx_installations_created_at ON installations (created_at);`,
      `DROP TRIGGER IF EXISTS trg_installations_updated_at ON installations;`,
      `
      CREATE TRIGGER trg_installations_updated_at
      BEFORE UPDATE ON installations
      FOR EACH ROW
      EXECUTE PROCEDURE set_updated_at();
      `,
    ];

    await client.query("BEGIN");
    try {
      for (let i = 0; i < stmts.length; i++) {
        await client.query(stmts[i]);
        push(`step_${i + 1}`, true);
      }
      await client.query("COMMIT");
      return { ok: true, steps };
    } catch (e) {
      await client.query("ROLLBACK");
      push("error", false, { message: e.message });
      return { ok: false, steps };
    }
  }

  const migrHandler = async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await applyMigration(client);
      res.status(result.ok ? 200 : 500).json(result);
    } finally {
      client.release();
    }
  };
  app.get("/__db/installations-apply-migration", migrHandler);
  app.post("/__db/installations-apply-migration", migrHandler);

  // ===== NEW: schema/connection introspection =====

  // 1) Where am I? DB, search_path, schema, user, server
  app.get("/__dbg/schema/where", async (req, res) => {
    const client = await pool.connect();
    try {
      const db = await client.query("SELECT current_database() AS db, current_schema() AS schema, current_user AS user;");
      const sp = await client.query("SHOW search_path;");
      const svr = await client.query("SELECT inet_server_addr() AS host, inet_server_port() AS port;");
      res.status(200).json({
        ok: true,
        db: db.rows[0]?.db,
        current_schema: db.rows[0]?.schema,
        current_user: db.rows[0]?.user,
        search_path: sp.rows[0]?.search_path,
        server: svr.rows[0],
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    } finally {
      client.release();
    }
  });

  // 2) List ALL tables across ALL non-system schemas
  app.get("/__dbg/schema/alltables", async (req, res) => {
    const client = await pool.connect();
    try {
      const r = await client.query(`
        SELECT table_schema, table_name
          FROM information_schema.tables
         WHERE table_type='BASE TABLE'
           AND table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_schema, table_name
      `);
      res.status(200).json({ ok: true, tables: r.rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    } finally {
      client.release();
    }
  });

  // 3) Columns for a table in a given schema
  //    /__dbg/schema/allcolumns?schema=<schema>&table=<table>
  app.get("/__dbg/schema/allcolumns", async (req, res) => {
    const schema = String(req.query.schema || "");
    const table = String(req.query.table || "");
    const ident = s => /^[A-Za-z0-9_]+$/.test(s);
    if (!ident(schema) || !ident(table)) {
      return res.status(400).json({ ok: false, code: "invalid_identifiers" });
    }
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema=$1 AND table_name=$2
          ORDER BY ordinal_position`,
        [schema, table]
      );
      res.status(200).json({ ok: true, schema, table, columns: r.rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    } finally {
      client.release();
    }
  });
}
