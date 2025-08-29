// referralsHook.js
// Fire-and-forget post-invoice referral crediting.
// Export: sendForInvoice(ctx)
// Uses: REFERRALS_ENABLED (toggle), and referralsClient.js

import { validateReferral, creditReferral } from "./referralsClient.js";

const ENABLED = String(process.env.REFERRALS_ENABLED ?? "true").toLowerCase() !== "false";

function pick(val, fallback = "") {
  return (val === undefined || val === null) ? fallback : val;
}

/**
 * ctx is the invoice row (or near-equivalent) you already pass from server.js
 * Expected useful fields (best-effort; hook is resilient to gaps):
 *  - id / invoice_id
 *  - customer_code
 *  - referral_code or __raw_referral_code (from request)
 *  - subtotal_ex_gst or total_before_gst or total_amount
 *  - gst_amount
 *  - total_qty_ml / dosage_ml
 *  - created_at / invoice_ts_ist
 */
export async function sendForInvoice(ctx = {}) {
  if (!ENABLED) return;

  try {
    const invoiceId = pick(ctx.id ?? ctx.invoice_id, null);
    const customerCode = pick(ctx.customer_code, "");
    const refCode = pick(ctx.referral_code ?? ctx.__raw_referral_code, "").trim();

    if (!invoiceId || !refCode) return;        // nothing to do without these
    // Optional preflight validate (non-fatal)
    try { await validateReferral(refCode); } catch {}

    const subtotal =
      Number(ctx.subtotal_ex_gst ?? ctx.total_before_gst ?? 0) ||
      Math.max(0, Number(ctx.total_amount ?? 0) - Number(ctx.gst_amount ?? 0));

    const payload = {
      invoiceId,
      customerCode,
      refCode,
      subtotal: Number.isFinite(subtotal) ? subtotal : 0,
      gst: Number(ctx.gst_amount ?? 0) || 0,
      litres: Number(ctx.total_qty_ml ?? ctx.dosage_ml ?? 0) || 0,
      createdAt: ctx.created_at ?? ctx.invoice_ts_ist ?? new Date().toISOString(),
    };

    // Fire-and-forget credit
    creditReferral(payload).catch(() => {});
  } catch {
    // hook must never throw into the request lifecycle
  }
}
