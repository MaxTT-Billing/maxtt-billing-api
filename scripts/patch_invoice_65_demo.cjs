// One-time demo: set distinct per-tyre treads for invoice 65
const { Client } = require('pg');

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error('DATABASE_URL missing'); process.exit(1); }
  const c = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    console.log('Patching invoice 65 per-tyre treads...');
    await c.query(`
      UPDATE invoices SET
        tread_fl_mm = 1.5,
        tread_fr_mm = 1.6,
        tread_rl_mm = 1.7,
        tread_rr_mm = 1.8
      WHERE id = 65
    `);
    console.log('Done.');
    process.exit(0);
  } catch (e) {
    console.error(e); process.exit(1);
  } finally { try { await c.end(); } catch {} }
})();
