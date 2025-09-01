// referralsHook.js — legacy hook used by older /api/invoices route
// It now delegates to referralsClient with HMAC so legacy flows also credit.

import { validateReferral, creditReferral } from './referralsClient.js';

export async function sendForInvoice(ctx = {}) {
  try {
    const refCode =
      (ctx.referral && String(ctx.referral.code || '').trim()) ||
      String(ctx.__raw_referral_code || '').trim();
    if (!refCode) return;

    // Best-effort validate (ignore failure)
    await validateReferral(refCode).catch(() => {});

    // Assemble credit payload (be tolerant to column names)
    const id = ctx.id ?? ctx.invoice_id;
    const customerCode =
      String(ctx.customer_code || ctx.customer_id || ctx.customer || ctx.cust_code || '').trim();
    const subtotal =
      Number(ctx.subtotal_ex_gst ?? ctx.subtotal ?? ctx.amount_before_tax ?? 0) || 0;
    const gst =
      Number(ctx.gst_amount ?? ctx.tax_amount ?? 0) || 0;
    const litres =
      Number(ctx.total_qty_ml ?? ctx.dosage_ml ?? ctx.qty_ml ?? 0) / 1000 || 0;
    const createdAt = ctx.created_at || ctx.invoice_ts_ist || new Date().toISOString();

    if (!id || !customerCode) return;

    await creditReferral({
      invoiceId: id,
      customerCode,
      refCode: String(refCode),
      subtotal,
      gst,
      litres,
      createdAt,
    }).catch(() => {});
  } catch {
    // swallow — hook must never break invoice creation
  }
}
