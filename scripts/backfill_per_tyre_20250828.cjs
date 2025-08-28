// scripts/backfill_per_tyre_20250828.cjs
// Copies legacy tread_depth_mm into any NULL per-tyre fields for existing rows.
const { Client } = require("pg");

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error("DATABASE_URL missing"); process.exit(1); }
  const db = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  try {
    await db.connect();
    console.log("Backfilling per-tyre from legacy depth...");

    const res = await db.query(`
      UPDATE invoices
         SET tread_fl_mm = COALESCE(tread_fl_mm, tread_depth_mm),
             tread_fr_mm = COALESCE(tread_fr_mm, tread_depth_mm),
             tread_rl_mm = COALESCE(tread_rl_mm, tread_depth_mm),
             tread_rr_mm = COALESCE(tread_rr_mm, tread_depth_mm)
       WHERE tread_depth_mm IS NOT NULL
         AND (tread_fl_mm IS NULL OR tread_fr_mm IS NULL OR tread_rl_mm IS NULL OR tread_rr_mm IS NULL)
      RETURNING id, tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm
    `);

    console.log("Rows updated:", res.rowCount);
    if (res.rows[0]) console.log("Sample:", res.rows[0]);
    console.log("Backfill complete.");
    process.exit(0);
  } catch (e) {
    console.error("Backfill failed:", e);
    process.exit(1);
  } finally {
    try { await db.end(); } catch {}
  }
})();
