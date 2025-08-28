// scripts/peek_hsn_after.cjs
// Quick sanity: list recent invoices' id, dosage_ml, hsn_code
const { Client } = require("pg");
const minId = Number(process.env.HSN_PEEK_MIN_ID || 60);

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error("DATABASE_URL missing"); process.exit(1); }
  const db = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await db.connect();
    console.log("Peek HSN from id >=", minId);
    const { rows } = await db.query(
      `SELECT id, dosage_ml, hsn_code
         FROM invoices
        WHERE id >= $1
        ORDER BY id`,
      [minId]
    );
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (e) {
    console.error("Peek failed:", e);
    process.exit(1);
  } finally {
    try { await db.end(); } catch {}
  }
})();
