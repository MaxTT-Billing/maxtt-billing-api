// routes/invoices.js
// Invoice routes with Seal & Earn integration

import express from "express";
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
// Create Invoice (SE-LIVE aware) : POST /api/invoices/full
// ------------------------------------------------------
router.post("/api/invoices/full", async (req, res) => {
  const body = req.body ?? {};
  const referral = body.referral ?? null;
  const refCode = typeof referral?.code === "string" ? referral.code.trim() : "";
  const bypass = referral?.bypass === true;

  try {
    // --- Safety checks ---
    await assertCanStartInstallation(body.franchiseeId);   // stock >= 20L to start
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
      res.status(201).json({ ok: true, id: invoice.id, printedNo: invoice.printedNo });

      // --- Post-commit: credit referral (fire-and-forget) ---
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
