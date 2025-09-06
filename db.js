// db.js
import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.DATABASE_SSL?.toLowerCase() === 'true' ? { rejectUnauthorized: false } : false
});

export const q = (text, params) => pool.query(text, params);
