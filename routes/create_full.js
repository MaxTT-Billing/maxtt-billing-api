// routes/create_full.js
// POST /api/invoices/full   — auto-generates printed invoice + unique customer_code
// GET  /api/invoices/:id/full2  — no-store fetch
//
// Enforces:
//  • Printed invoice: TS-SS-CCC-NNNN/MMYY (e.g., TS-DL-DEL-001/0087/0825)
//  • Customer Code:  <FranchiseeCode>-NNNN (unique via DB constraint)
//  • Default HSN (sealant) = 35069999, GST = 18%
//  • After commit: referral validate (non-fatal) + credit

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

// ---------- Seq helpers (DB-driven, safe against duplicates) ----------
async function nextCustomerSeq(client, franchisee) {
  // Find current max NNNN for this franchisee in "<Franchisee>-NNNN"
  const r = await client.query(
    `
    SELECT COALESCE(MAX(CAST(regexp_replace(${qid("customer_code")},
           '.*-(\\d{1,4})$','\\1') AS integer)), 0) AS maxseq
    FROM public.invoices
    WHERE ${qid("franchisee_code")} = $1
    `,
    [franchisee]
  );
  return Number(r.rows[0]?.maxseq || 0) + 1;
}

async function nextInvoiceSeqFromInvno(client, franchisee) {
  // Find max NNNN inside "TS-..../NNNN/MMYY" for this franchisee
  const r = await client.query(
    `
    SELECT COALESCE(MAX(CAST(regexp_replace(${qid("invoice_number")},
           '.*/(\\d{1,4})/\\d{4}$','\\1') AS integer)), 0) AS maxseq
    FROM public.invoices
    WHERE ${qid("franchisee_code")} = $1
    `,
    [franchisee]
  );
  return Number(r.rows[0]?.maxseq || 0) + 1;
}

// ---------- Routes ----------
router.post("/api/invoices/full", async (req, res) => {
  const body = req.body || {};
  const refCode = (body?.referral?.code || "").trim();

  const client = await pool.connect();
  try {
    const cols = await getInvoiceCols(client);

    const franchisee = String(
      body.franchisee_code ?? body.franchisee_id ?? body.franchise_code ?? ""
    ).trim();
    if (!franchisee) return res.status(400).json({ error: "franchisee_code_required" });

    // Lock per franchisee to avoid races
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [franchisee]);

    const nowIstISO = istNow().toISOString();
    const pricing = computePricing(body);

    // Compute starting sequences from DB MAX (safer than "last row")
    let cseq = await nextCustomerSeq(client, franchisee);
    let iseq = await nextInvoiceSeqFromInvno(client, franchisee);

    // Fill fields (may be overwritten in retry)
    const base = {
      ...body,
      franchisee_code: franchisee,
      subtotal_ex_gst: pricing.subtotal_ex_gst,
      gst_rate: pricing.gst_rate,
      gst_amount: pricing.gst_amount,
      total_amount: pricing.total_amount,
      hsn_code: pricing.hsn_code,
    };
    if (has(cols, "invoice_ts_ist")) base.invoice_ts_ist = nowIstISO;

    // Try insert with retry on duplicate customer_code
    const MAX_RETRIES = 5;
    let lastErr = null;
    let row = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const customer_code = body.customer_code?.trim() || `${franchisee}-${String(cseq).padStart(4, "0")}`;
      const mmyy = fmtMMYY(istNow());
      const invoice_number = body.invoice_number?.trim() || `${franchisee}/${String(iseq).padStart(4, "0")}/${mmyy}`;

      try {
        row = await insertInvoice(client, { ...base, customer_code, invoice_number });
        lastErr = null;
        break;
      } catch (e) {
        const msg = String(e?.message || e);
        lastErr = msg;
        // On unique violation for customer_code, bump seq and retry
        if (/duplicate key value.*customer_code/i.test(msg)) {
          cseq++;
          iseq++; // keep invoice seq in step to avoid aesthetic gaps
          continue;
        }
        throw e; // some other error
      }
    }

    if (!row) throw new Error(lastErr || "insert_failed");

    await client.query("COMMIT");

    // Respond
    const out = {
      ok: true,
      id: row.id ?? row.invoice_id,
      invoice_number: row.invoice_number,
      customer_code: row.customer_code,
    };
    res.status(201).json(out);

    // Post-commit: referrals (non-blocking)
    if (refCode) {
      try {
        await validateReferral(refCode).catch(() => {});
        await creditReferral({
          invoiceId: row.id ?? row.invoice_id,
          customerCode: row.customer_code,
          refCode,
          subtotal: pricing.subtotal_ex_gst,
          gst: pricing.gst_amount,
          litres: Number(body.total_qty_ml ?? body.dosage_ml ?? 0) / 1000,
          createdAt: row.created_at ?? nowIstISO,
        }).catch(() => {});
      } catch {}
    }
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    const msg = err?.message || String(err);
    return res.status(400).json({ error: msg });
  } finally {
    client.release();
  }
});

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
