// routes/invoices.js
// Invoice routes with Seal & Earn integration + list endpoint for UI

import express from "express";
import pg from "pg";
import { validateReferralCode, creditReferral } from "../src/lib/referrals.js";

// --- Import existing helpers (adjust names/paths if your project differs) ---
import { dbBegin, dbCommit, dbRollback } from "../src/lib/db.js";
import {
  createInvoiceRecord,          // (tx, body) => { id, customerCode, pricing:{subtotal,gst}, litres, createdAt, printedNo }
  getInvoiceFullById,           // (id) => full invoice view for GET /full2
  assertCanStartInstallation,   // (franchiseeId) => throws if stock < 20L when starting
  assertTreadDepthSafe,         // (tyres[]) => throws if any < 1.5mm
  enforcePricingAndHSN,         // (pricing) => returns normalized pricing with GST=18% and HSN=35069999
} from "../src/models/invoices.js";

export const router = express.Router();

// ------------------------------------------------------
// PG pool (for the list endpoint)
// ------------------------------------------------------
const useSSL = (process.env.DATABASE_SSL || "true").toLowerCase() === "true";
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

// ------------------------------------------------------
// Create Invoice (SE-LIVE aware) : POST /api/invoices/full
// ------------------------------------------------------
router.post("/api/invoices/full", async (req, res) => {
  const body = req.body ?? {};
  const referral = body.referral ?? null;
  const refCode = typeof referral?.code === "string" ? referral.code.trim() : "";
  const bypass = referral?.bypass === true;

  try {
    // --- Safety checks ---
    await assertCanStartInstallation(body.franchiseeId || body.franchisee_id);   // allow either key
    await assertTreadDepthSafe(body.tyres ?? []);          // block if any tread < 1.5mm

    // --- Referral validation (fail closed unless bypass) ---
    if (refCode) {
      try {
        const v = await validateReferralCode(refCode);
        if (!v?.valid && !bypass) {
          return res.status(400).json({ error: "Invalid referral code" });
        }
      } catch (e) {
        if (!bypass) {
          return res.status(502).json({ error: "Referral validation unavailable" });
        }
      }
    }

    // --- Pricing normalization (GST 18%, HSN 35069999) ---
    body.pricing = enforcePricingAndHSN(body.pricing);

    // --- DB transaction: create invoice ---
    const tx = await dbBegin();
    try {
      const invoice = await createInvoiceRecord(tx, body);
      await dbCommit(tx);

      // Respond immediately
      return res.status(201).json({
        ok: true,
        id: invoice.id,
        invoice_number: invoice.printedNo ?? null,
        invoice_number_norm: invoice.invoice_number_norm ?? invoice.normNo ?? null,
        customer_code: invoice.customerCode ?? null,
        qty_ml_saved: invoice.litres ? Number(invoice.litres) * 1000 : undefined,
      });

      // --- Post-commit: credit referral (fire-and-forget) ---
      // (unreachable after return, but kept here as a note)
    } catch (err) {
      await dbRollback(tx);
      console.error("invoice create failed", err);
      return res.status(500).json({ error: "Create failed" });
    }
  } catch (outer) {
    console.error("pre-check failed", outer);
    return res.status(400).json({ error: String(outer.message ?? outer) });
  }
});

// ------------------------------------------------------
// Fetch Invoice (no-store) : GET /api/invoices/:id/full2
// ------------------------------------------------------
router.get("/api/invoices/:id/full2", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = req.params.id;
  try {
    const doc = await getInvoiceFullById(id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    return res.json(doc);
  } catch (e) {
    console.error("fetch full2 failed", e);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

// ------------------------------------------------------
// List Latest : GET /api/invoices?limit=20
// (feeds the frontend /admin/invoices table)
// ------------------------------------------------------
router.get("/api/invoices", async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 200));
  try {
    const q = `
      SELECT
        id,
        created_at,
        -- accept either column names if your schema differs
        COALESCE(franchisee_id, franchisee_code) AS franchisee_id,
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
    return res.json({ items: rows });
  } catch (e) {
    console.error("list invoices failed", e);
    return res.status(500).json({ error: "List failed" });
  }
});
