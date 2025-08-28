// routes/debug.js (ESM)
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET /debug/invoices/columns  -> list columns visible to this service
router.get("/debug/invoices/columns", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_name = 'invoices'
        ORDER BY column_name`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "query_failed" });
  }
});

// GET /debug/invoices/:id -> raw row (SELECT *)
router.get("/debug/invoices/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
    const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "query_failed" });
  }
});

// POST /debug/invoices/:id/treads  -> patch per-tyre values for testing
router.post("/debug/invoices/:id/treads", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });

    const { tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm } = req.body || {};
    const vals = [tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm];

    if (vals.some(v => v === undefined))
      return res.status(400).json({ error: "missing_values" });

    await pool.query(
      `UPDATE invoices
          SET tread_fl_mm = $1,
              tread_fr_mm = $2,
              tread_rl_mm = $3,
              tread_rr_mm = $4
        WHERE id = $5`,
      [tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm, id]
    );

    const { rows } = await pool.query(`SELECT id, tread_fl_mm, tread_fr_mm, tread_rl_mm, tread_rr_mm FROM invoices WHERE id = $1`, [id]);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "patch_failed" });
  }
});

export default router;
