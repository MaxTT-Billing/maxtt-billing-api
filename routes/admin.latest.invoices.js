// routes/admin.latest.invoices.js
// Read-only admin invoices listing with normalized fields for UI.
// Uses only columns known to exist in your DB: id, created_at, invoice_number_norm,
// customer_code, tyre_count, total_with_gst. Everything else is derived.

import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
});

const adminLatestInvoicesRouter = express.Router();

adminLatestInvoicesRouter.get("/ping", (_req, res) => res.json({ ok: true }));

// Helper: printed number from norm  =>  {prefix}/{MMYY}/{seq}
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

// Helper: franchisee code from norm  =>  strip trailing -####
// e.g. TS-HR-GGM-001-0019  ->  TS-HR-GGM-001
function franchiseeFromNorm(norm) {
  if (!norm) return null;
  const m = String(norm).match(/^(.*)-\d{4}$/);
  return m ? m[1] : null;
}

/**
 * GET /api/invoices/admin/latest
 * Output fields:
 *  - id, created_at
 *  - franchisee_code (derived from norm)
 *  - printed_no  (derived from norm)
 *  - norm_no     (invoice_number_norm)
 *  - customer_code (raw stored)
 *  - tyre_count, total_with_gst
 */
adminLatestInvoicesRouter.get("/latest", async (_req, res) => {
  try {
    const q = `
      SELECT
        id,
        created_at,
        invoice_number_norm,
        customer_code,
        tyre_count,
        total_with_gst
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
        customer_code: r.customer_code ?? null,   // raw as stored (C000xxx or legacy)
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
