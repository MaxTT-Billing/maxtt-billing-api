// routes/invoices.js
// Invoice routes with Seal & Earn integration + printed invoice number + UI list

import express from "express";
import pg from "pg";
import { validateReferralCode, creditReferral } from "../src/lib/referrals.js";

// --- DB helpers (your existing modules) ---
import { dbBegin, dbCommit, dbRollback } from "../src/lib/db.js";
import {
  createInvoiceRecord,          // (tx, body) => { id, customerCode, pricing:{subtotal,gst}, litres, createdAt, printedNo?, invoice_number_norm? }
  getInvoiceFullById,           // (id) => full invoice view for GET /full2
  assertCanStartInstallation,   // (franchiseeId) => throws if stock < 20L when starting
  assertTreadDepthSafe,         // (tyres[]) => throws if any < 1.5mm
  enforcePricingAndHSN,         // (pricing) => returns normalized pricing with GST=18% and HSN=35069999
} from "../src/models/invoices.js";

export const router = express.Router();

// ---------- PG pool (for list + post-create update) ----------
const useSSL = (process.env.DATABASE_SSL || "true").toLowerCase() === "true";
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

// ---------- helpers ----------
function mmYY(d = new Date()) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}${yy}`; // e.g., 0925
}

function makePrintedFromNorm(norm) {
  // norm looks like: TS-HR-GGM-001-0005
  if (!norm || typeof norm !== "string") return null;
  const m = norm.match(/^(.*)-(\d{4})$/);
  if (!m) return null;
  const prefix = m[1];     // TS-HR-GGM-001
  const seq = m[2];        // 0005
  return `${prefix}/${mmYY()}/${seq}`; // TS-HR-GGM-001/0925/0005
}

// ------------------------------------------------------
// Create Invoice : POST /api/invoices/full
// ------------------------------------------------------
router.post("/api/invoices/full", async (req, res) => {
  const body = req.body ?? {};
  const referral = body.referral ?? null;
  const refCode = typeof referral?.code === "string" ? referral.code.trim() : "";
  const bypass = referral?.bypass === true;
  const franchiseeId = body.franchiseeId || body.franchisee_id;

  try {
    // --- Safety checks ---
    await assertCanStartInstallation(franchiseeId);
    await assertTreadDepthSafe(body.tyres ?? []);

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

    // --- DB transaction: create invoice + set printed invoice number ---
    const tx = await dbBegin();
    try {
      const invoice = await createInvoiceRecord(tx, body);

      // If printed number not created by model, create it now from the normalized number
      let norm = invoice?.invoice_number_norm ?? invoice?.normNo ?? null;
      let printed = invoice?.printedNo ?? null;
      if (!printed && norm) {
        printed = makePrintedFromNorm(norm);
        if (printed) {
          await tx.query(
            `UPDATE public.invoices SET invoice_number = $1 WHERE id = $2`,
            [printed, invoice.id]
          );
        }
      }

      await dbCommit(tx);

      // Respond to client
      res.status(201).json({
        ok: true,
        id: invoice.id,
        invoice_number: printed ?? null,
        invoice_number_norm: norm ?? null,
        customer_code: invoice.customerCode ?? null,
        qty_ml_saved: invoice.litres ? Number(invoice.litres) * 1000 : undefined,
      });

      // --- Post-commit: credit referral (fire-and-forget) ---
      if (refCode) {
        creditReferral({
          invoiceId: invoice.id,
          customerCode: invoice.customerCode,
          refCode,
          subtotal: invoice.pricing?.subtotal,
          gst: invoice.pricing?.gst,
          litres: invoice.litres,
          createdAt: invoice.createdAt,
        }).catch((err) => console.error("referral credit failed", err));
      }
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
// Ensures printed invoice_number present in response
// ------------------------------------------------------
router.get("/api/invoices/:id/full2", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = req.params.id;
  try {
    const doc = await getInvoiceFullById(id);
    if (!doc) return res.status(404).json({ error: "Not found" });

    // If invoice_number missing but norm available, compute for response
    let invoice_number = doc.invoice_number || null;
    if (!invoice_number && doc.invoice_number_norm) {
      const computed = makePrintedFromNorm(doc.invoice_number_norm);
      if (computed) invoice_number = computed;
    }

    return res.json({ ...doc, invoice_number });
  } catch (e) {
    console.error("fetch full2 failed", e);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

// ------------------------------------------------------
// Optional: Rich list for UI  : GET /api/invoices/list?limit=20
// (keeps legacy /api/invoices untouched; frontend can switch later)
// ------------------------------------------------------
router.get("/api/invoices/list", async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 200));
  try {
    const q = `
      SELECT
        id,
        created_at,
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
