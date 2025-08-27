// File: scripts/inspect_schema_20250827.cjs
const { Client } = require('pg');

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('== Public tables ==');
    const t = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    for (const r of t.rows) console.log('-', r.table_name);

    console.log('\n== Columns per likely candidates ==');
    const candidates = ['invoice_items','invoice_item','invoice_lines','invoice_line_items','invoices','invoice_products','items','line_items'];
    for (const name of candidates) {
      const q = await client.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1
        ORDER BY ordinal_position
      `, [name]);
      if (q.rows.length) {
        console.log(`\nTable: ${name}`);
        for (const c of q.rows) console.log(`  - ${c.column_name} (${c.data_type})`);
      }
    }
    process.exit(0);
  } catch (e) {
    console.error('Inspect failed:', e);
    process.exit(1);
  } finally {
    try { await client.end(); } catch {}
  }
})();
