// routes/admin.latest.invoices.js
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
});

const adminLatestInvoicesRouter = express.Router();

adminLatestInvoicesRouter.get("/ping", (_req, res) => res.json({ ok: true }));

function printedFromNorm(norm, createdAt) {
  if (!norm) return null;
  const m = String(norm).match(/^(.*)-(\d{4})$/);
  if (!m) return norm;
  const seq = m[2];
  const d = createdAt ? new Date(createdAt) : new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${m[1]}/${mm}${yy}/${seq}`;
}

function franchiseeFromNorm(norm) {
  if (!norm) return null;
  const m = String(norm).match(/^(.*)-\d{4}$/);
  return m ? m[1] : null;
}

adminLatestInvoicesRouter.get("/latest", async (_req, res) => {
  try {
    const q = `
      SELECT id, created_at, invoice_number_norm, customer_code, tyre_count, total_with_gst
      FROM invoices
      ORDER BY id DESC
      LIMIT 200
    `;
    const { rows } = await pool.query(q);

    const out = rows.map((r) => {
      const norm = r.invoice_number_norm || null;
      const created = r.created_at || null;

      return {
        id: r.id,
        created_at: created,
        franchisee_code: franchiseeFromNorm(norm),
        printed_no: printedFromNorm(norm, created),
        norm_no: norm,
        // what UI should show everywhere:
        customer_code_display: norm,                 // <- THIS is what you want
        // raw in DB (kept for audit/legacy):
        customer_code_raw: r.customer_code ?? null,  // C000xxx or legacy
        tyre_count: r.tyre_count ?? null,
        total_with_gst: r.total_with_gst ?? null,
      };
    });

    res.json(out);
  } catch (e) {
    console.error("admin.latest error", e);
    res.status(500).json({ error: "admin_latest_failed" });
  }
});

export default adminLatestInvoicesRouter;
