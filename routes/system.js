// routes/system.js  (ESM)
import pkg from "pg";
import { runSelfTest } from "../src/selftest.js";

const { Pool } = pkg;

export default function systemRouter(app) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // ---- Self-test: verify table/constraints
  app.get("/__db/installations-selftest", async (req, res) => {
    try {
      const report = await runSelfTest(pool);
      res.status(200).json({ ok: true, report });
    } catch (err) {
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // ---- One-time migration: create installations table (+ function/trigger/indexes)
  async function applyMigration(client) {
    const steps = [];
    const push = (name, ok, details = null) => steps.push({ name, ok, details });

    // DDL statements are idempotent (CREATE IF NOT EXISTS / OR REPLACE)
    const stmts = [
      // helper function for updated_at
      `
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      `,
      // table
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
      // indexes
      `CREATE INDEX IF NOT EXISTS idx_installations_franchisee ON installations (franchisee_id);`,
      `CREATE INDEX IF NOT EXISTS idx_installations_status ON installations (status);`,
      `CREATE INDEX IF NOT EXISTS idx_installations_created_at ON installations (created_at);`,
      // trigger
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

  // Allow GET (easy in browser) and POST (safer) to run it once
  const handler = async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await applyMigration(client);
      res.status(result.ok ? 200 : 500).json(result);
    } finally {
      client.release();
    }
  };
  app.get("/__db/installations-apply-migration", handler);
  app.post("/__db/installations-apply-migration", handler);
}
