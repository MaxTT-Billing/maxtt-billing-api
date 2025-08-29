// src/routes/invoices.js
// Full routes module with Seal & Earn integration.
// Assumes your existing db/model helpers are available as imported below.
// If your import paths differ, keep names but adjust paths accordingly.

import express from "express";
import { validateReferralCode, creditReferral } from "../lib/referrals.js";

// --- Import your existing app utilities (adjust paths if needed) ---
import { dbBegin, dbCommit, dbRollback } from "../lib/db.js";
import {
  createInvoiceRecord,          // (tx, body) => { id, customerCode, pricing:{subtotal,gst}, litres, createdAt, printedNo }
  getInvoiceFullById,           // (id) => full invoice view for GET /full2
  assertCanStartInstallation,   // (franchiseeId) => throws if stock < 20L when starting
  assertTreadDepthSafe,         // (tyres[]) => throws if any < 1.5mm
  enforcePricingAndHSN,         // (pricing) => returns normalized pricing with GST and HSN defaults
} from "../models/invoices.js";

export const router = express.Router();

// ---------------------------------------------
// Create (SE-LIVE aware)  POST /api/invoices/full
// ---------------------------------------------
router.post("/api/invoices/full", async (req, res) => {
  const body = req.body ?? {};
  const referral = body.referral ?? null;
  const refCode = typeof referral?.code === "string" ? referral.code.trim() : "";
  const bypass = referral?.bypass === true; // Super Admin only flow, if your auth layer sets/permits it

  try {
    // 0) Safety rails, same as before
    //    - Enforce locks exactly as your previous logic does
    await assertCanStartInstallation(body.franchiseeId);         // throws if stock < 20L at start
    await assertTreadDepthSafe(body.tyres ?? []);                 // throws if any tyre tread < 1.5mm

    // 1) Optional referral validation (fail-closed unless bypass)
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

    // 2) Normalize pricing (enforce HSN=35069999 default, GST=18%) — identical outcome as before
    body.pricing = enforcePricingAndHSN(body.pricing);

    // 3) DB transaction: create invoice
    const tx = await dbBegin();
    try {
      const invoice = await createInvoiceRecord(tx, body);
      await dbCommit(tx);

      // Respond immediately
      res.status(201).json({ ok: true, id: invoice.id, printedNo: invoice.printedNo });

      // 4) Post-commit: referral credit (non-blocking)
      if (refCode) {
        creditReferral({
          invoiceId: invoice.id,
          customerCode: invoice.customerCode,
          refCode,
          subtotal: invoice.pricing.subtotal,
          gst: invoice.pricing.gst,
          litres: invoice.litres,
          createdAt: invoice.createdAt,
        }).catch((err) => {
          console.error("referral credit failed", err);
        });
      }
    } catch (err) {
      await dbRollback(tx);
      console.error("invoice create failed", err);
      return res.status(500).json({ error: "Create failed" });
    }
  } catch (outer) {
    console.error("pre-check failed", outer);
    // propagate specific errors from locks if you already do so
    return res.status(400).json({ error: String(outer.message ?? outer) });
  }
});

// ----------------------------------------------------
// Fetch (no-store)  GET /api/invoices/:id/full2
// ----------------------------------------------------
router.get("/api/invoices/:id/full2", async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); // as required
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
