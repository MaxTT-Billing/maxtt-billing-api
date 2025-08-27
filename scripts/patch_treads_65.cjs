// One-time patch: set distinct per-tyre treads for invoice ID 65
const { Client } = require("pg");

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error("DATABASE_URL missing"); process.exit(1); }
  const db = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  try {
    await db.connect();
    console.log("Patching invoice 65 per-tyre treads...");
    await db.query(`
      UPDATE invoices
         SET tread_fl_mm = 1.5,
             tread_fr_mm = 1.6,
             tread_rl_mm = 1.7,
             tread_rr_mm = 1.8
       WHERE id = 65
    `);
    const { rows } = await db.query(`
      SELECT id, tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm
        FROM invoices WHERE id = 65
    `);
    console.log("After patch:", rows[0]);
    console.log("Done.");
    process.exit(0);
  } catch (e) {
    console.error("Patch failed:", e);
    process.exit(1);
  } finally {
    try { await db.end(); } catch {}
  }
})();
