// File: scripts/peek_invoices_63_64.cjs
const { Client } = require('pg');

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error('DATABASE_URL missing'); process.exit(1); }
  const c = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const ids = [63, 64];
    for (const id of ids) {
      const r = await c.query(
        `SELECT id, odometer, tread_depth_mm,
                tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm,
                hsn_code, customer_code, created_at
         FROM invoices WHERE id=$1`, [id]);
      console.log('INVOICE', id, ':', r.rows[0] || null);
    }
    process.exit(0);
  } catch (e) {
    console.error(e); process.exit(1);
  } finally { try { await c.end(); } catch {} }
})();
