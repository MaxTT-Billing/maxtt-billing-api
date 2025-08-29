// scripts/migrate_20250829_codes.cjs
// 1) Franchisees table (for future use; with format check)
// 2) Drop any old customer_code trigger
// 3) Unique index on invoices.customer_code (when present)

const { Client } = require("pg");

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error("DATABASE_URL missing"); process.exit(1); }
  const db = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  try {
    await db.connect();
    console.log("Migrating: franchisees table + constraints...");

    await db.query(`
      CREATE TABLE IF NOT EXISTS franchisees (
        code TEXT PRIMARY KEY,
        name TEXT,
        state TEXT,
        city TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
        CONSTRAINT franchisee_code_format CHECK (code ~ '^TS-[A-Z]{2}-[A-Z]{3}-[0-9]{3}$')
      );
    `);

    console.log("Dropping legacy customer_code trigger/function if present...");
    await db.query(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoices_customer_code_before') THEN
        DROP TRIGGER trg_invoices_customer_code_before ON invoices;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_customer_code_from_id') THEN
        DROP FUNCTION set_customer_code_from_id();
      END IF;
    END $$;`);

    console.log("Creating unique index on invoices.customer_code (nullable)...");
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS invoices_customer_code_uniq
        ON invoices (customer_code)
        WHERE customer_code IS NOT NULL;
    `);

    console.log("Migration complete.");
    process.exit(0);
  } catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
  } finally {
    try { await db.end(); } catch {}
  }
})();
