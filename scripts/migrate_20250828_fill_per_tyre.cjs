// scripts/migrate_20250828_fill_per_tyre.cjs
// Creates a trigger so that if tread_depth_mm is provided,
// any missing per-tyre (FL/FR/RL/RR) are auto-filled from it.
const { Client } = require("pg");

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error("DATABASE_URL missing"); process.exit(1); }
  const db = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await db.connect();
    console.log("Running PT trigger migration...");

    const sql = `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'fill_per_tyre_from_legacy'
          AND n.nspname = 'public'
      ) THEN
        CREATE FUNCTION public.fill_per_tyre_from_legacy() RETURNS trigger AS $BODY$
        BEGIN
          IF NEW.tread_depth_mm IS NOT NULL THEN
            IF NEW.tread_fl_mm IS NULL THEN NEW.tread_fl_mm := NEW.tread_depth_mm; END IF;
            IF NEW.tread_fr_mm IS NULL THEN NEW.tread_fr_mm := NEW.tread_depth_mm; END IF;
            IF NEW.tread_rl_mm IS NULL THEN NEW.tread_rl_mm := NEW.tread_depth_mm; END IF;
            IF NEW.tread_rr_mm IS NULL THEN NEW.tread_rr_mm := NEW.tread_depth_mm; END IF;
          END IF;
          RETURN NEW;
        END;
        $BODY$ LANGUAGE plpgsql;
      END IF;
    END
    $$;

    DROP TRIGGER IF EXISTS trg_fill_per_tyre ON invoices;

    CREATE TRIGGER trg_fill_per_tyre
    BEFORE INSERT OR UPDATE OF tread_depth_mm, tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm
    ON invoices
    FOR EACH ROW
    EXECUTE PROCEDURE public.fill_per_tyre_from_legacy();
    `;

    await db.query(sql);
    console.log("PT trigger migration complete.");
    process.exit(0);
  } catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
  } finally {
    try { await db.end(); } catch {}
  }
})();
