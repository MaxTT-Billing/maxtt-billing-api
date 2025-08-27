// File: scripts/peek_latest_invoice_20250827.cjs
const { Client } = require('pg');

(async () => {
  const cs = process.env.DATABASE_URL;
  const c = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const r = await c.query(`SELECT id, customer_code, hsn_code, created_at FROM invoices ORDER BY id DESC LIMIT 1;`);
    console.log('LATEST INVOICE:', r.rows[0]);
  } catch (e) { console.error(e); process.exit(1); }
  finally { try { await c.end(); } catch {} }
})();
