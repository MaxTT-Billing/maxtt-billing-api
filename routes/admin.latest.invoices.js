// routes/admin.latest.invoices.js
// Read-only admin invoices listing with normalized fields for UI.
// No writes. No side-effects.

import express from "express";
import pkg from "pg";

const { Pool } = pkg;

// Use existing DATABASE_URL env (same as app)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
});

export const adminLatestInvoicesRouter = express.Router();

// simple health
adminLatestInvoicesRouter.get("/ping", (req, res) => res.json({ ok: true }));

/**
 * GET /api/invoices/admin/latest
 * Returns a list with normalized fields:
 * - id
 * - created_at
 * - franchisee_code (or franchisee_id fallback)
 * - printed_no   => derived from invoice_number_norm as `${prefix}/${MMYY}/${seq}`
 * - norm_no      => invoice_number_norm
 * - customer_code (raw as stored)
 * - tyre_count
 * - total_with_gst
 */
adminLatestInvoicesRouter.get("/latest", async (req, res) => {
  try {
    // Prefer the same SELECT the app uses for listing, but keep it defensive.
    const q = `
      SELECT
        id,
        created_at,
        franchisee_code,
        franchisee_id,
        invoice_number,
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
      const id = r.id;
      const created = r.created_at;
      const norm = r.invoice_number_norm || null;

      // printed number from norm: {prefix}/{MMYY}/{seq}
      let printed = r.invoice_number || null;
      if (!printed && norm) {
        const m = String(norm).match(/^(.*)-(\d{4})$/);
        if (m) {
          const seq = m[2];
          const d = created ? new Date(created) : new Date();
          const mm = String((d.getUTCMonth() + 1)).padStart(2, "0");
          const yy = String(d.getUTCFullYear()).slice(-2);
          printed = `${m[1]}/${mm}${yy}/${seq}`;
        }
      }

      return {
        id,
        created_at: created,
        franchisee_code: r.franchisee_code || r.franchisee_id || null,
        printed_no: printed,
        norm_no: norm,
        customer_code: r.customer_code ?? null, // show raw, do not transform
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
