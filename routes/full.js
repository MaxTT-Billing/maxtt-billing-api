// ESM route to return ALL invoice columns
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// /api/invoices/:id/full and /invoices/:id/full
router.get(["/api/invoices/:id/full", "/invoices/:id/full"], async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "bad id" });
  try {
    const { rows } = await pool.query("SELECT * FROM invoices WHERE id=$1", [id]);
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
