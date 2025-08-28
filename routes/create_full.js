// routes/create_full.js  (ESM)
import express from "express";
import pkg from "pg";
import { extractReferralCode, postReferral } from "../referralsClient.js";

const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// number coercion (undefined if empty)
const num = (v) => (v === null || v === undefined || v === "" ? undefined : Number(v));

/**
 * POST /api/invoices/full
 * - Inserts into invoices (server stamps created_at if not provided).
 * - Accepts per-tyre treads OR legacy tread_depth_mm (auto-fills per-tyre if only legacy sent).
 * - If hsn_code absent, defaults to Sealant HSN = 35069999.
 * - After save, extracts referral code (from body.referral_code or body.remarks) and
 *   fires a non-blocking POST to Seal & Earn.
 */
router.post(["/api/invoices/full", "/invoices/full"], async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (!body.created_at) body.created_at = new Date().toISOString();

    // Defaults
    if (!body.hsn_code) body.hsn_code = "35069999"; // Sealant default

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

    // If per-tyre missing but legacy depth present, auto-fill all four
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

    // Insert only columns that exist
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
    const saved = rows[0];

    // Kick off Seal & Earn (non-blocking)
    try {
      const refCode = body.referral_code || extractReferralCode(body.remarks || "");
      if (refCode) {
        const payload = {
          referral_code: refCode,
          customer_code: saved.customer_code || (saved.id ? `C${String(saved.id).padStart(6,"0")}` : ""),
          invoice_id: saved.id,
          invoice_number: saved.invoice_number || body.invoice_number || "",
          amount: saved.total_with_gst || 0,
          created_at: saved.created_at,
          franchisee_id: saved.franchisee_id || body.franchisee_id || body.franchisee_code || ""
        };
        postReferral(payload).then(r => {
          console.log("[Seal&Earn] result:", r);
        }).catch(e => {
          console.warn("[Seal&Earn] failed:", e?.message || e);
        });
      }
    } catch (e) {
      console.warn("[Seal&Earn] skipped/error:", e?.message || e);
    }

    return res.status(201).json(saved);
  } catch (e) {
    console.error("insert failed:", e);
    return res.status(500).json({ error: "insert_failed" });
  }
});

/** GET /api/invoices/:id/full2 — returns SELECT * for the invoice */
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
