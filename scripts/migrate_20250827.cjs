// File: scripts/migrate_20250827.cjs
// Run a SQL migration file against DATABASE_URL (works with "type":"module" via .cjs)

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL not set');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'db', 'migrations', '20250827_add_hsn_customer_code.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error('ERROR: Migration SQL not found at', sqlPath);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log('Running migration 20250827...');
    await client.query(sql);
    console.log('Migration 20250827 complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    try { await client.end(); } catch (_) {}
  }
})();
