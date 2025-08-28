// scripts/backfill_hsn_20250828.cjs
// Backfill HSN for sealant invoices where it's missing/wrong.
// Rule: if dosage_ml > 0 => sealant => HSN 35069999
const { Client } = require("pg");

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error("DATABASE_URL missing"); process.exit(1); }
  const db = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await db.connect();
    console.log("Backfilling HSN for sealant invoices...");

    const res = await db.query(`
      UPDATE invoices
         SET hsn_code = '35069999'
       WHERE COALESCE(dosage_ml,0) > 0
         AND (hsn_code IS NULL
              OR hsn_code IN ('3403.19.00','34031900','3403.19','', 'N/A'))
      RETURNING id, dosage_ml, hsn_code
    `);

    console.log("Rows updated:", res.rowCount);
    if (res.rows[0]) console.log("Sample:", res.rows[0]);
    console.log("HSN backfill complete.");
    process.exit(0);
  } catch (e) {
    console.error("Backfill failed:", e);
    process.exit(1);
  } finally {
    try { await db.end(); } catch {}
  }
})();
