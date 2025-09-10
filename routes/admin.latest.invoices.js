import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
});

const adminLatestInvoicesRouter = express.Router();

adminLatestInvoicesRouter.get("/ping", (_req, res) => res.json({ ok: true }));

adminLatestInvoicesRouter.get("/latest", async (_req, res) => {
  try {
    // Select only columns we know exist everywhere. Avoid optional columns in SQL.
    const q = `
      SELECT
        id,
        created_at,
        invoice_number,          -- printed (nullable)
        invoice_number_norm,     -- normalized (nullable)
        customer_code,           -- may be 'C000xxx' or legacy 'TS-...-0009'
        tyre_count,
        total_with_gst,
        -- keep JSON if your schema has it; otherwise COALESCE(NULL) is harmless
        COALESCE(invoice_json, NULL) AS invoice_json
      FROM invoices
      ORDER BY id DESC
      LIMIT 200
    `;
    const { rows } = await pool.query(q);

    const out = rows.map((r) => {
      const id = r.id;
      const created = r.created_at;
      const norm = r.invoice_number_norm || null;

      // Try to get franchisee from a few places without selecting potentially-missing columns
      let franchisee = null;
      if (r.invoice_json && typeof r.invoice_json === "object") {
        // e.g., some schemas store it inside JSON
        franchisee =
          r.invoice_json.franchisee_code ||
          r.invoice_json.franchisee_id ||
          r.invoice_json.franchisee ||
          null;
      }
      // If still null, leave it null (frontend will show "-")

      // printed number from either invoice_number or derived from norm
      let printed = r.invoice_number || null;
      if (!printed && norm) {
        const m = String(norm).match(/^(.*)-(\d{4})$/);
        if (m) {
          const seq = m[2];
          const d = created ? new Date(created) : new Date();
          const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
          const yy = String(d.getUTCFullYear()).slice(-2);
          printed = `${m[1]}/${mm}${yy}/${seq}`;
        } else {
          printed = norm; // fallback: show whatever we have
        }
      }

      return {
        id,
        created_at: created,
        franchisee_code: franchisee,
        printed_no: printed,
        norm_no: norm,
        customer_code: r.customer_code ?? null,
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
