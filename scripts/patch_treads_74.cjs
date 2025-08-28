// scripts/patch_treads_74.cjs
// One-time patch: set per-tyre treads for invoice ID 74
const { Client } = require("pg");

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error("DATABASE_URL missing"); process.exit(1); }
  const db = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  // >>> EDIT these values to the actual readings you want on #74
  const FL = 2.1;
  const FR = 2.2;
  const RL = 2.3;
  const RR = 2.4;

  try {
    await db.connect();
    console.log("Patching invoice 74 per-tyre treads...");
    await db.query(`
      UPDATE invoices
         SET tread_fl_mm = $1,
             tread_fr_mm = $2,
             tread_rl_mm = $3,
             tread_rr_mm = $4
       WHERE id = 74
    `, [FL, FR, RL, RR]);

    const { rows } = await db.query(`
      SELECT id, tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm
        FROM invoices WHERE id = 74
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
