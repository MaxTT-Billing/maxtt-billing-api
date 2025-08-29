// routes/create_full.js  (ESM)
// Adds CORS/OPTIONS handling at router level + enforces codes.

import express from "express";
import pkg from "pg";
import { extractReferralCode, postReferral } from "../referralsClient.js";

const { Pool } = pkg;
const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---- CORS & JSON (fixes “Failed to fetch” preflight) ----
router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
router.use(express.json({ limit: "2mb" }));
// ---------------------------------------------------------

// utils
const num = (v) => (v === null || v === undefined || v === "" ? undefined : Number(v));
const FR_REGEX = /^TS-[A-Z]{2}-[A-Z]{3}-\d{3}$/;
const INV_REGEX = /^(TS-[A-Z]{2}-[A-Z]{3}-\d{3})\/[A-Z0-9-]+\/(\d{4})\/(\d{4})$/;

// inline local S&E stub (kept)
const LOCAL_API_KEY = process.env.SEAL_EARN_API_KEY || "";
router.get("/debug/referrals/ping", (_req, res) => {
  res.json({ ok: true, where: "create_full_inline_stub" });
});
router.post("/api/referrals", (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!LOCAL_API_KEY || token !== LOCAL_API_KEY) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const p = req.body || {};
    console.log("[Seal&Earn:LOCAL-inline] referral:", {
      referral_code: p.referral_code,
      customer_code: p.customer_code,
      invoice_id: p.invoice_id,
      invoice_number: p.invoice_number,
      amount: p.amount,
      created_at: p.created_at,
      franchisee_id: p.franchisee_id,
    });
    return res.json({ ok: true, mode: "local-inline" });
  } catch (e) {
    console.error("local inline se error:", e);
    return res.status(500).json({ ok: false, error: "stub_error" });
  }
});

// POST /api/invoices/full
router.post(["/api/invoices/full", "/invoices/full"], async (req, res) => {
  try {
    const body = { ...(req.body || {}) };

    // Strict codes enforcement
    const invoiceNumber = String(body.invoice_number || "").trim();
    if (!invoiceNumber) {
      return res.status(400).json({ error: "invoice_number_required" });
    }
    const invm = invoiceNumber.match(INV_REGEX);
    if (!invm) {
      return res.status(400).json({
        error: "bad_invoice_number_format",
        expect: "TS-SS-CCC-NNN/XX/NNNN/MMYY (e.g., TS-DL-DEL-001/XX/0086/0825)"
      });
    }
    const franchiseeCode = invm[1];
    const seq = invm[2];
    if (!FR_REGEX.test(franchiseeCode)) {
      return res.status(400).json({ error: "bad_franchisee_code", value: franchiseeCode });
    }
    const derivedCustomerCode = `${franchiseeCode}-${seq}`;
    body.franchisee_id = franchiseeCode;
    body.customer_code = derivedCustomerCode;

    if (!body.created_at) body.created_at = new Date().toISOString();
    if (!body.hsn_code) body.hsn_code = "35069999"; // Sealant default

    // numbers
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

    // per-tyre from legacy
    const hasPerTyre = [body.tread_fl_mm, body.tread_fr_mm, body.tread_rl_mm, body.tread_rr_mm]
      .some(v => v !== undefined);
    if (!hasPerTyre && body.tread_depth_mm !== undefined) {
      body.tread_fl_mm = body.tread_depth_mm;
      body.tread_fr_mm = body.tread_depth_mm;
      body.tread_rl_mm = body.tread_depth_mm;
      body.tread_rr_mm = body.tread_depth_mm;
    }

    // insert
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

    let saved;
    try {
      const r = await pool.query(
        `INSERT INTO invoices (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      saved = r.rows[0];
    } catch (e) {
      if (e && e.code === "23505") {
        return res.status(409).json({ error: "duplicate_customer_code", customer_code: body.customer_code });
      }
      throw e;
    }

    // Seal & Earn (non-blocking)
    try {
      const refCode = body.referral_code || extractReferralCode(body.remarks || "");
      if (refCode) {
        const payload = {
          referral_code: refCode,
          customer_code: saved.customer_code,
          invoice_id: saved.id,
          invoice_number: saved.invoice_number || invoiceNumber,
          amount: saved.total_with_gst || 0,
          created_at: saved.created_at,
          franchisee_id: saved.franchisee_id
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

// GET /api/invoices/:id/full2
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
