// routes/create_full.js  (ESM)
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Insert into invoices; if created_at not provided, set to NOW() (UTC)
router.post(["/api/invoices/full", "/invoices/full"], async (req, res) => {
  try {
    const body = req.body || {};

    // discover actual columns in DB
    const { rows: colsRows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'invoices'`
    );
    const colset = new Set(colsRows.map(r => r.column_name));

    // ensure created_at (server time) if absent
    if (!body.created_at) {
      body.created_at = new Date().toISOString(); // UTC
    }

    const CANDIDATE = [
      "created_at","customer_name","mobile_number","vehicle_number","installer_name",
      "vehicle_type","tyre_width_mm","aspect_ratio","rim_diameter_in",
      "dosage_ml","price_per_ml","gst_rate","total_before_gst","gst_amount","total_with_gst",
      "gps_lat","gps_lng","customer_code","tyre_count","fitment_locations","customer_gstin",
      "customer_address","franchisee_id","updated_at","customer_signature","signed_at",
      "consent_signature","consent_signed_at","consent_snapshot","declaration_snapshot",
      "hsn_code","invoice_number",
      "odometer","tread_depth_mm","tread_fl_mm","tread_fr_mm","tread_rl_mm","tread_rr_mm"
    ];

    const keys = CANDIDATE.filter(k => body[k] !== undefined && colset.has(k));
    if (!keys.length) return res.status(400).json({ error: "no valid fields" });

    const cols = keys.map(k => `"${k}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const values = keys.map(k => body[k]);

    const { rows } = await pool.query(
      `INSERT INTO invoices (${cols}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "insert failed" });
  }
});

export default router;
