// routes/create_full.js — Column-aware "full" invoice routes
// POST /api/invoices/full  -> creates an invoice (auto printed no + customer code)
// GET  /api/invoices/:id/full2 -> returns full row (no-store)
//
// Key behavior:
//  • Detects actual DB column names (franchisee, invoice_number, customer_code, etc.) at runtime
//  • Generates printed invoice number TS-SS-CCC-NNNN/MMYY and customer code <Franchisee>-NNNN
//  • Only inserts into columns that really exist
//  • If a target column is missing in DB, still generates values (for response + referrals)
//  • Enforces GST 18% + HSN 35069999
//  • Posts referral credit after commit (fire-and-forget)

import express from "express";
import pkg from "pg";
const { Pool } = pkg;

import { validateReferral, creditReferral } from "../referralsClient.js";

const router = express.Router();

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- Helpers ----------
let cachedCols = null;
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
const pick = (cols, candidates) => candidates.find((c) => has(cols, c)) || null;

function istNow() {
  const now = new Date();
  return new Date(now.getTime() + 330 * 60 * 1000);
}
function fmtMMYY(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}${yy}`;
}
function computePricing(input = {}) {
  const qty = Number(input.total_qty_ml ?? input.qty_ml ?? input.quantity_ml ?? input.dosage_ml ?? 0) || 0;
  const mrp = Number(input.mrp_per_ml ?? input.price_per_ml ?? input.rate_per_ml ?? input.mrp_ml ?? 0) || 0;
  const install = Number(input.installation_cost ?? input.install_cost ?? input.labour ?? input.labour_cost ?? 0) || 0;
  const disc = Number(input.discount_amount ?? input.discount ?? input.disc ?? 0) || 0;
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
    litres: qty / 1000,
  };
}
async function insertInvoice(client, payload) {
  const cols = await getInvoiceCols(client);
  const data = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    if (has(cols, k)) data[k] = v;
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

// ---------- Routes ----------
router.post("/api/invoices/full", async (req, res) => {
  const body = req.body || {};
  const refCode = (body?.referral?.code || "").trim();

  const client = await pool.connect();
  try {
    const cols = await getInvoiceCols(client);

    // Resolve actual column names
    const COL = {
      franch: pick(cols, ["franchisee_code", "franchisee", "franchise_code", "franchisee_id"]),
      invNo: pick(cols, ["invoice_number", "invoice_no", "inv_no", "bill_no", "invoice"]),
      custCode: pick(cols, ["customer_code", "customer_id", "customer", "cust_code"]),
      createdAt: pick(cols, ["created_at", "invoice_date", "date", "createdon", "created_on"]),
      invTsIst: pick(cols, ["invoice_ts_ist"]),
      subtotal: pick(cols, ["subtotal_ex_gst", "subtotal", "amount_before_tax", "amount_ex_gst", "pre_tax_total", "total_before_gst"]),
      gstRate: pick(cols, ["gst_rate", "tax_rate", "gst_percent", "gst"]),
      gstAmt: pick(cols, ["gst_amount", "tax_amount", "gst_value"]),
      totalAmt: pick(cols, ["total_amount", "grand_total", "total", "amount", "total_with_gst"]),
      hsn: pick(cols, ["hsn_code", "hsn", "hsncode"]),
    };

    // Franchisee code (required for numbering), but we store it only if that column exists.
    const franchisee = String(
      body.franchisee_code ?? body.franchisee ?? body.franchise_code ?? body.franchisee_id ?? ""
    ).trim();
    if (!franchisee) {
      return res.status(400).json({ error: "franchisee_code_required" });
    }

    // Lock per franchisee to avoid races
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [franchisee]);

    // Compute current max sequences ONLY if those columns exist; else start at 0
    let cseq = 0;
    if (COL.custCode && COL.franch) {
      const r = await client.query(
        `
        SELECT COALESCE(MAX(CAST(regexp_replace(${qid(COL.custCode)},
               '.*-(\\d{1,4})$','\\1') AS integer)), 0) AS maxseq
        FROM public.invoices
        WHERE ${qid(COL.franch)} = $1
        `,
        [franchisee]
      );
      cseq = Number(r.rows[0]?.maxseq || 0);
    }

    let iseq = 0;
    if (COL.invNo && COL.franch) {
      const r = await client.query(
        `
        SELECT COALESCE(MAX(CAST(regexp_replace(${qid(COL.invNo)},
               '.*/(\\d{1,4})/\\d{4}$','\\1') AS integer)), 0) AS maxseq
        FROM public.invoices
        WHERE ${qid(COL.franch)} = $1
        `,
        [franchisee]
      );
      iseq = Number(r.rows[0]?.maxseq || 0);
    }

    const mmyy = fmtMMYY(istNow());
    const nextCustSeq = (cseq || 0) + 1;
    const nextInvSeq = (iseq || 0) + 1;

    const genCustomerCode = `${franchisee}-${String(nextCustSeq).padStart(4, "0")}`;
    const genInvoiceNumber = `${franchisee}/${String(nextInvSeq).padStart(4, "0")}/${mmyy}`;

    // Compute pricing
    const pricing = computePricing(body);
    const nowIstISO = istNow().toISOString();

    // Build row to insert — include only columns that exist
    const rowToInsert = {
      // store franchisee if column exists
      ...(COL.franch ? { [COL.franch]: franchisee } : {}),
      // store generated numbers into whichever columns exist
      ...(COL.invNo ? { [COL.invNo]: body.invoice_number?.trim() || genInvoiceNumber } : {}),
      ...(COL.custCode ? { [COL.custCode]: body.customer_code?.trim() || genCustomerCode } : {}),

      // pricing
      ...(COL.subtotal ? { [COL.subtotal]: pricing.subtotal_ex_gst } : {}),
      ...(COL.gstRate ? { [COL.gstRate]: pricing.gst_rate } : {}),
      ...(COL.gstAmt ? { [COL.gstAmt]: pricing.gst_amount } : {}),
      ...(COL.totalAmt ? { [COL.totalAmt]: pricing.total_amount } : {}),
      ...(COL.hsn ? { [COL.hsn]: pricing.hsn_code } : {}),

      // invoice timestamp (if column exists)
      ...(COL.invTsIst ? { [COL.invTsIst]: nowIstISO } : {}),
      // include all passthrough body fields that match existing columns
      ...body,
    };

    // Insert (only existing columns are included by insertInvoice)
    const row = await insertInvoice(client, rowToInsert);

    await client.query("COMMIT");

    // Respond with generated numbers even if those columns don't exist in DB
    const id = row.id ?? row.invoice_id;
    const outInvoiceNo = row[COL.invNo] ?? (body.invoice_number?.trim() || genInvoiceNumber);
    const outCustomerCode = row[COL.custCode] ?? (body.customer_code?.trim() || genCustomerCode);

    res.status(201).json({
      ok: true,
      id,
      invoice_number: outInvoiceNo,
      customer_code: outCustomerCode,
    });

    // Post-commit referrals (non-blocking)
    if (refCode) {
      try {
        await validateReferral(refCode).catch(() => {});
        await creditReferral({
          invoiceId: id,
          customerCode: outCustomerCode,
          refCode,
          subtotal: pricing.subtotal_ex_gst,
          gst: pricing.gst_amount,
          litres: pricing.litres,
          createdAt: row.created_at ?? nowIstISO,
        }).catch(() => {});
      } catch {}
    }
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    return res.status(400).json({ error: err?.message || String(err) });
  } finally {
    client.release();
  }
});

// FULL invoice passthrough (ALL columns) — /full2
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
    return res.status(500).json({ error: "fetch_failed" });
  } finally {
    client.release();
  }
});

export default router;
