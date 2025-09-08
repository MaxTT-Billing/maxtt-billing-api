// routes/invoices.js
// Treadstone Solutions — Invoices API: create + fetch + list + PDF (brand)
// FULL FILE

import express from "express";
import pg from "pg";
import PDFDocument from "pdfkit";
import { validateReferralCode, creditReferral } from "../src/lib/referrals.js";
import { dbBegin, dbCommit, dbRollback } from "../src/lib/db.js";
import {
  createInvoiceRecord,
  getInvoiceFullById,
  assertCanStartInstallation,
  assertTreadDepthSafe,
  enforcePricingAndHSN,
} from "../src/models/invoices.js";

export const router = express.Router();

// ---------- PG pool (list + post-create update) ----------
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
function printedFromNorm(norm) {
  if (!norm || typeof norm !== "string") return null;
  const m = norm.match(/^(.*)-(\d{4})$/);
  if (!m) return null;
  const prefix = m[1];
  const seq = m[2];
  return `${prefix}/${mmYY()}/${seq}`;
}
function rupee(n) {
  if (n == null) return "-";
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  return v.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
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
    await assertCanStartInstallation(franchiseeId);
    await assertTreadDepthSafe(body.tyres ?? []);

    if (refCode) {
      try {
        const v = await validateReferralCode(refCode);
        if (!v?.valid && !bypass) return res.status(400).json({ error: "Invalid referral code" });
      } catch {
        if (!bypass) return res.status(502).json({ error: "Referral validation unavailable" });
      }
    }

    body.pricing = enforcePricingAndHSN(body.pricing);

    const tx = await dbBegin();
    try {
      const invoice = await createInvoiceRecord(tx, body);

      // ensure printed invoice_number persisted
      let norm = invoice?.invoice_number_norm ?? invoice?.normNo ?? null;
      let printed = invoice?.invoice_number ?? invoice?.printedNo ?? null;
      if (!printed && norm) {
        printed = printedFromNorm(norm);
        if (printed) {
          await tx.query(`UPDATE public.invoices SET invoice_number = $1 WHERE id = $2`, [printed, invoice.id]);
        }
      }

      await dbCommit(tx);

      res.status(201).json({
        ok: true,
        id: invoice.id,
        invoice_number: printed ?? null,
        invoice_number_norm: norm ?? null,
        customer_code: invoice.customerCode ?? null,
        qty_ml_saved: invoice.litres ? Number(invoice.litres) * 1000 : undefined,
      });

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
// Fetch one (no-store) : GET /api/invoices/:id/full2
// ------------------------------------------------------
router.get("/api/invoices/:id/full2", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = req.params.id;
  try {
    const doc = await getInvoiceFullById(id);
    if (!doc) return res.status(404).json({ error: "Not found" });

    let invoice_number = doc.invoice_number || null;
    if (!invoice_number && doc.invoice_number_norm) {
      const computed = printedFromNorm(doc.invoice_number_norm);
      if (computed) invoice_number = computed;
    }

    return res.json({ ...doc, invoice_number });
  } catch (e) {
    console.error("fetch full2 failed", e);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

// ------------------------------------------------------
// Rich list for UI : GET /api/invoices/list?limit=20
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

// ------------------------------------------------------
// PDF: GET /api/invoices/:id/pdf  (Content-Type: application/pdf)
// ------------------------------------------------------
router.get("/api/invoices/:id/pdf", async (req, res) => {
  const id = req.params.id;
  try {
    const inv = await getInvoiceFullById(id);
    if (!inv) return res.status(404).json({ error: "Not found" });

    // compute printed if missing
    const invoice_number = inv.invoice_number || printedFromNorm(inv.invoice_number_norm) || `INV-${id}`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice_number}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    // Header
    doc
      .fontSize(18)
      .text("TREADSTONE SOLUTIONS", { align: "left" })
      .moveDown(0.3)
      .fontSize(10)
      .text("MaxTT — Tyre Life Extension", { align: "left" })
      .moveDown(0.6);

    // Invoice info
    doc
      .fontSize(12)
      .text(`Invoice #: ${invoice_number}`)
      .text(`Date: ${new Date().toLocaleDateString("en-IN")}`)
      .text(`Franchisee: ${inv.franchisee_id || inv.franchisee_code || "-"}`)
      .moveDown(0.6);

    // Customer / job section (use what’s available)
    doc
      .fontSize(11)
      .text(`Customer Code: ${inv.customer_code || "-"}`)
      .text(`Vehicle: ${inv.vehicle_number || "-"}`)
      .text(`Tyres: ${inv.tyre_count ?? "-"}`)
      .moveDown(0.6);

    // Pricing table (simple)
    const subtotal = Number(inv.total_before_gst ?? 0);
    const gst = Number(inv.gst_amount ?? 0);
    const total = Number(inv.total_with_gst ?? 0);
    doc
      .fontSize(12)
      .text(`Subtotal: ${rupee(subtotal)}`)
      .text(`GST (18%): ${rupee(gst)}`)
      .text(`Total: ${rupee(total)}`)
      .moveDown(1);

    // Declarations
    doc
      .fontSize(9)
      .text("Declaration:", { underline: true })
      .moveDown(0.2)
      .text(
        "1) Treatment performed as per Treadstone Solutions SOP. " +
          "2) Invoice auto-generated by MaxTT system. " +
          "3) Subject to jurisdiction of New Delhi, India."
      )
      .moveDown(1);

    // Signature boxes
    const y = doc.y;
    doc.rect(40, y, 220, 60).stroke();
    doc.text("Customer Signature", 50, y + 45);
    doc.rect(320, y, 220, 60).stroke();
    doc.text("Installer Signature", 330, y + 45);

    // Watermark
    doc
      .rotate(-30, { origin: [300, 500] })
      .fontSize(60)
      .fillColor("#EEEEEE")
      .text("TREADSTONE", 80, 450, { opacity: 0.3 })
      .fillColor("#000000")
      .rotate(30, { origin: [300, 500] });

    doc.end();
  } catch (e) {
    console.error("pdf generate failed", e);
    return res.status(500).json({ error: "PDF failed" });
  }
});
