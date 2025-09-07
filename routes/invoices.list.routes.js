// routes/invoices.list.routes.js
import express from "express";
import pg from "pg";

const router = express.Router();

// ---- PG Pool (Render Postgres) ----
const useSSL = (process.env.DATABASE_SSL || "true").toLowerCase() === "true";
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

// GET /api/invoices  -> latest N rows with full fields for UI list
router.get("/api/invoices", async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 200));
  try {
    const q = `
      SELECT
        id,
        created_at,
        franchisee_id,
        franchisee_code,      -- if present in your table
        invoice_number,
        invoice_number_norm,
        customer_code,
        tyre_count,
        total_with_gst
      FROM public.invoices
      ORDER BY id DESC
      LIMIT $1
    `;
    const { rows } = await pool.query(q, [limit]);
    // Normalize a bit for UI
    const items = rows.map(r => ({
      id: r.id,
      created_at: r.created_at,
      franchisee_id: r.franchisee_id || r.franchisee_code || null,
      invoice_number: r.invoice_number || null,
      invoice_number_norm: r.invoice_number_norm || null,
      customer_code: r.customer_code || null,
      tyre_count: r.tyre_count ?? null,
      total_with_gst: r.total_with_gst ?? null,
    }));
    return res.json({ items });
  } catch (e) {
    console.error("list invoices failed", e);
    return res.status(500).json({ error: "List failed" });
  }
});

export default router;
