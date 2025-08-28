// routes/create_full.js  (ESM)
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Helper: coerce to number if provided, else undefined
const num = (v) => (v === null || v === undefined || v === "" ? undefined : Number(v));

/**
 * POST /api/invoices/full
 * - Inserts into invoices.
 * - Server stamps created_at if not provided.
 * - If only legacy tread_depth_mm is provided, auto-fill per-tyre (FL/FR/RL/RR) with that value.
 */
router.post(["/api/invoices/full", "/invoices/full"], async (req, res) => {
  try {
    const body = { ...(req.body || {}) };

    // Ensure server time if client didn't send created_at
    if (!body.created_at) body.created_at = new Date().toISOString();

    // Normalize numeric-like fields
    body.odometer         = num(body.odometer);
    body.tread_depth_mm   = num(body.tread_depth_mm);
    body.tread_fl_mm      = num(body.tread_fl_mm);
    body.tread_fr_mm      = num(body.tread_fr_mm);
    body.tread_rl_mm      = num(body.tread_rl_mm);
    body.tread_rr_mm      = num(body.tread_rr_mm);
    body.dosage_ml        = num(body.dosage_ml);
    body.price_per_ml     = num(body.price_per_ml);
    body.gst_rate         = num(body.gst_rate);
    body.total_before_gst = num(body.total_before_gst);
    body.gst_amount       = num(body.gst_amount);
    body.total_with_gst   = num(body.total_with_gst);
    body.tyre_width_mm    = num(body.tyre_width_mm);
    body.aspect_ratio     = num(body.aspect_ratio);
    body.rim_diameter_in  = num(body.rim_diameter_in);

    // If per-tyre missing but legacy depth present, auto-fill all four with legacy
    const hasPerTyre =
      body.tread_fl_mm !== undefined ||
      body.tread_fr_mm !== undefined ||
      body.tread_rl_mm !== undefined ||
      body.tread_rr_mm !== undefined;

    if (!hasPerTyre && body.tread_depth_mm !== undefined) {
      body.tread_fl_mm = body.tread_depth_mm;
      body.tread_fr_mm = body.tread_depth_mm;
      body.tread_rl_mm = body.tread_depth_mm;
      body.tread_rr_mm = body.tread_depth_mm;
    }

    // Discover actual columns so we only insert what exists
    const { rows: colsRows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'invoices'`
    );
    const colset = new Set(colsRows.map((r) => r.column_name));

    const CANDIDATE = [
      "created_at","customer_name","mobile_number","vehicle_number","installer_name",
      "vehicle_type","tyre_width_mm","aspect_ratio","rim_diameter_in",
      "dosage_ml","price_per_ml","gst_rate","total_before_gst","gst_amount","total_with_gst",
      "gps_lat","gps_lng","customer_code","tyre_count","fitment_locations","customer_gstin",
      "customer_address","franchisee_id","updated_at","customer_signature","signed_at",
      "consent_signature","consent_signed_at","consent_snapshot","declaration_snapshot",
      "hsn_code","invoice_number",
      // per-tyre + legacy + odometer
      "odometer","tread_depth_mm","tread_fl_mm","tread_fr_mm","tread_rl_mm","tread_rr_mm"
    ];

    const keys = CANDIDATE.filter((k) => body[k] !== undefined && colset.has(k));
    if (!keys.length) return res.status(400).json({ error: "no_valid_fields" });

    const cols = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const values = keys.map((k) => body[k]);

    const { rows } = await pool.query(
      `INSERT INTO invoices (${cols}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error("insert failed:", e);
    return res.status(500).json({ error: "insert_failed" });
  }
});

/**
 * GET /api/invoices/:id/full2
 * - Returns ALL columns from invoices for this id.
 */
router.get(["/api/invoices/:id/full2", "/invoices/:id/full2"], async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
    const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    return res.json(rows[0]);
  } catch (e) {
    console.error("full2 failed:", e);
    return res.status(500).json({ error: "query_failed" });
  }
});

export default router;
