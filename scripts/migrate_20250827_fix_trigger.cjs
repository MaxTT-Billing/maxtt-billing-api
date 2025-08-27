// File: scripts/migrate_20250827_fix_trigger.cjs
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const cs = process.env.DATABASE_URL;
  if (!cs) { console.error('DATABASE_URL missing'); process.exit(1); }

  const sqlPath = path.join(__dirname, '..', 'db', 'migrations', '20250827_fix_customer_code_trigger.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('Running migration 20250827 fix (customer_code BEFORE trigger)...');
    await client.query(sql);
    console.log('Migration 20250827 fix complete.');
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  } finally {
    try { await client.end(); } catch {}
  }
})();
