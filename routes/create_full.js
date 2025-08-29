// routes/create_full.js
// Canonical "full" invoice routes for MaxTT Billing API.
// - POST /api/invoices/full : creates an invoice; auto-generates printed invoice number
// - GET  /api/invoices/:id/full2 : fetches full row (no-store)
// Rules enforced here:
//   • Printed invoice format: TS-SS-CCC-NNN/NNNN/MMYY  (e.g., TS-DL-DEL-001/0087/0825)
//   • Customer Code = <FranchiseeCode>-<SEQ> (zero-padded 4)
//   • Default HSN (sealant) = 35069999
//   • GST = 18%
//   • Optional referrals: body.referral.code → validate (non-fatal) → credit post-commit

import express from "express";
import pkg from "pg";
const { Pool } = pkg;

import { validateReferral, creditReferral } from "../referralsClient.js";

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- Helpers ----------
let cachedCols = null;
/** Return Set of lowercase column names for public.invoices */
async function getInvoiceCols(client) {
  if (cachedCols) return cachedCols;
  const r = await client.query(`
    SELECT lower(column_name) AS name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices'
  `);
  cachedCols = new Set(r.rows.map((x) => x.name));
  return cachedCols;
}
const has = (cols, name) => cols.has(String(name).toLowerCase());
const qid = (s) => `"${s}"`;

/** Get IST (UTC+5:30) Date object as ISO string */
function istNow() {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist;
}
function fmtMMYY(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}${yy}`;
}

/** Parse last 4-digit sequence from an invoice_number like TS-.../0087/0825 */
function parseSeq(invNo) {
  if (!invNo) return 0;
  const m = String(invNo).match(/\/(\d{1,4})\//);
  return m ? parseInt(m[1], 10) || 0 : 0;
}
/** Parse last 4-digit suffix from a customer_code like TS-...-0007 */
function parseCustSeq(cc) {
  if (!cc) return 0;
  const m = String(cc).match(/-(\d{1,4})$/);
  return m ? parseInt(m[1], 10) || 0 : 0;
}

/** Compute totals with GST 18% and default HSN */
function computePricing(input = {}) {
  const qty = Number(input.total_qty_ml ?? input.qty_ml ?? 0) || 0;
  const mrp = Number(input.mrp_per_ml ?? input.price_per_ml ?? 0) || 0;
  const install = Number(input.installation_cost ?? 0) || 0;
  const disc = Number(input.discount_amount ?? 0) || 0;
  let subtotal = qty * mrp + install - disc;
  if (!Number.isFinite(subtotal) || subtotal < 0) subtotal = 0;
  const gstRate = 18;
  const gstAmt = +(subtotal * 0.18).toFixed(2);
  const total = +(subtotal + gstAmt).toFixed(2);
  return {
    subtotal_ex_gst: subtotal,
    gst_rate: gstRate,
    gst_amount: gstAmt,
    total_amount: total,
    hsn_code: "35069999",
  };
}

/** Insert row with dynamic column set */
async function insertInvoice(client, payload) {
  const cols = await getInvoiceCols(client);
  const data = {};
  for (const [k, v] of Object.entries(payload)) {
    if (has(cols, k) && v !== undefined) data[k] = v;
  }
  const keys = Object.keys(data);
  if (!keys.length) throw new Error("no_matching_columns");
  const colSql = keys.map(qid).join(", ");
  const valSql = keys.map((_, i) => `$${i + 1}`).join(", ");
  const vals = keys.map((k) => data[k]);
  const sql = `INSERT INTO public.invoices (${colSql}) VALUES (${valSql}) RETURNING *`;
  const r = await client.query(sql, vals);
  return r.rows[0];
}

// ---------- Router ----------
const router = express.Router();

/**
 * POST /api/invoices/full
 * Accepts body; if invoice_number missing, generate it.
 * Also fills customer_code, pricing (GST 18%, HSN 35069999), and sets invoice_ts_ist when column exists.
 */
router.post("/api/invoices/full", async (req, res) => {
  const body = req.body || {};
  const refCode =
    (body.referral && typeof body.referral.code === "string" && body.referral.code.trim()) || "";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cols = await getInvoiceCols(client);

    // --- Franchisee code is required to build printed number & customer code
    const franchisee = String(
      body.franchisee_code ??
        body.franchisee_id ??
        body.franchise_code ??
        ""
    ).trim();
    if (!franchisee) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "franchisee_code_required" });
    }

    // --- Advisory lock to avoid concurrent sequence clashes per franchisee
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [franchisee]);

    // --- Build invoice_number if not provided
    let invoice_number = String(body.invoice_number || "").trim();
    if (!invoice_number) {
      // find latest sequence for this franchisee
      let seq = 0;
      if (has(cols, "invoice_number") && has(cols, "franchisee_code")) {
        const r = await client.query(
          `SELECT ${qid("invoice_number")} 
             FROM public.invoices 
            WHERE ${qid("franchisee_code")} = $1 
            ORDER BY ${has(cols, "id") ? qid("id") : qid("invoice_id")} DESC 
            LIMIT 1`,
          [franchisee]
        );
        if (r.rows.length) seq = parseSeq(r.rows[0].invoice_number);
      }
      const next = (seq || 0) + 1;
      const seqStr = String(next).padStart(4, "0");
      const mmyy = fmtMMYY(istNow());
      invoice_number = `${franchisee}/${seqStr}/${mmyy}`;
    }

    // --- Build customer_code if not provided: <FranchiseeCode>-<SEQ4>
    let customer_code = String(body.customer_code || "").trim();
    if (!customer_code) {
      let cseq = 0;
      if (has(cols, "customer_code") && has(cols, "franchisee_code")) {
        const r = await client.query(
          `SELECT ${qid("customer_code")} 
             FROM public.invoices 
            WHERE ${qid("franchisee_code")} = $1 
            ORDER BY ${has(cols, "id") ? qid("id") : qid("invoice_id")} DESC 
            LIMIT 1`,
          [franchisee]
        );
        if (r.rows.length) cseq = parseCustSeq(r.rows[0].customer_code);
      }
      const next = (cseq || 0) + 1;
      const seqStr = String(next).padStart(4, "0");
      customer_code = `${franchisee}-${seqStr}`;
    }

    // --- Compute pricing (GST 18%, HSN 35069999)
    const pricing = computePricing(body);

    // --- Prepare row
    const nowIst = istNow().toISOString();
    const baseRow = {
      ...body,
      invoice_number,
      customer_code,
      subtotal_ex_gst: pricing.subtotal_ex_gst,
      gst_rate: pricing.gst_rate,
      gst_amount: pricing.gst_amount,
      total_amount: pricing.total_amount,
      hsn_code: pricing.hsn_code,
    };
    if (has(cols, "invoice_ts_ist")) baseRow.invoice_ts_ist = nowIst;
    if (!baseRow.franchisee_code && has(cols, "franchisee_code")) baseRow.franchisee_code = franchisee;

    // --- Insert
    const row = await insertInvoice(client, baseRow);

    await client.query("COMMIT");

    // Respond first
    res.status(201).json({
      ok: true,
      id: row.id ?? row.invoice_id,
      invoice_number,
      customer_code,
    });

    // --- Post-commit: referrals (non-blocking)
    if (refCode) {
      try {
        // validate is non-fatal; ignore failures
        await validateReferral(refCode).catch(() => {});
        await creditReferral({
          invoiceId: row.id ?? row.invoice_id,
          customerCode: customer_code,
          refCode,
          subtotal: pricing.subtotal_ex_gst,
          gst: pricing.gst_amount,
          litres: Number(body.total_qty_ml ?? body.dosage_ml ?? 0) / 1000, // if you store ml, convert to L for credits
          createdAt: row.created_at ?? nowIst,
        }).catch(() => {});
      } catch {
        // swallow — never fail the request due to referral side
      }
    }
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("create_full error:", err);
    const msg = err && err.message ? String(err.message) : "Create failed";
    res.status(400).json({ error: msg });
  } finally {
    client.release();
  }
});

/**
 * GET /api/invoices/:id/full2   (no-store)
 * Returns complete row from public.invoices
 */
router.get("/api/invoices/:id/full2", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const idRaw = req.params.id;
  const client = await pool.connect();
  try {
    const cols = await getInvoiceCols(client);
    const idCol = has(cols, "id") ? "id" : "invoice_id";
    const r = await client.query(
      `SELECT * FROM public.invoices WHERE ${qid(idCol)} = $1 LIMIT 1`,
      [idRaw]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error("full2 fetch error:", e);
    return res.status(500).json({ error: "fetch_failed" });
  } finally {
    client.release();
  }
});

export default router;
