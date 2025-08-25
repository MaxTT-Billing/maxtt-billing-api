// referralsHook.js — map a Billing "invoice row" into a referral and fire-and-forget

import { postReferral } from './referralsClient.js';

const ON = process.env.REF_ENABLE === '1';
const DEBUG = process.env.REF_DEBUG === '1';

// helper to pick first non-empty
const pick = (obj, keys = []) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};

function toISODateOnly(x) {
  if (!x) return undefined;
  try {
    const d = new Date(x);
    if (Number.isNaN(d.getTime())) return undefined;
    // use date only (API accepts a date string or ISO)
    return d.toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

/**
 * Convert an invoice row to referral payload.
 * Expected invoice object fields (we probe multiple common names):
 * - referral_code / referrer_customer_code
 * - invoice_number / invoice_no / inv_no / id
 * - franchisee_code / franchise_code
 * - total_with_gst / total_amount / grand_total / subtotal_ex_gst+gst_amount
 * - created_at / invoice_date / date / createdon / created_on
 */
export function buildReferralFromInvoice(inv) {
  const referrer_customer_code = String(
    pick(inv, ['referrer_customer_code', 'referral_code', 'customer_referral_code'])
  || ''
  ).trim();

  const referred_invoice_code = String(
    pick(inv, ['invoice_number', 'invoice_no', 'inv_no', 'bill_no', 'id'])
  || ''
  ).trim();

  const franchisee_code = String(
    pick(inv, ['franchisee_code', 'franchise_code'])
  || ''
  ).trim();

  // amount
  let invoice_amount_inr =
    pick(inv, ['total_with_gst', 'total_amount', 'grand_total']);

  if (invoice_amount_inr === undefined) {
    const sub = Number(pick(inv, ['total_before_gst', 'subtotal_ex_gst', 'subtotal', 'amount_before_tax']) || 0);
    const gst = Number(pick(inv, ['gst_amount', 'tax_amount', 'gst_value']) || 0);
    invoice_amount_inr = sub + gst;
  }
  const amt = Number(invoice_amount_inr || 0);
  const invoice_date = toISODateOnly(
    pick(inv, ['created_at', 'invoice_date', 'date', 'createdon', 'created_on'])
  );

  return {
    referrer_customer_code,
    referred_invoice_code,
    franchisee_code,
    invoice_amount_inr: Number.isFinite(amt) ? Number(amt.toFixed(2)) : undefined,
    invoice_date,
  };
}

/**
 * Fire-and-forget sender. Never throws; never blocks the API response.
 */
export function sendForInvoice(inv) {
  if (!ON) {
    DEBUG && console.log('[referrals] disabled (REF_ENABLE!=1)');
    return;
  }
  try {
    const payload = buildReferralFromInvoice(inv);
    const missing = [];
    if (!payload.referrer_customer_code) missing.push('referrer_customer_code');
    if (!payload.referred_invoice_code)  missing.push('referred_invoice_code');
    if (!payload.franchisee_code)        missing.push('franchisee_code');
    if (!payload.invoice_amount_inr)     missing.push('invoice_amount_inr');
    if (!payload.invoice_date)           missing.push('invoice_date');

    if (missing.length) {
      DEBUG && console.warn('[referrals] skip; missing:', missing);
      return;
    }

    // do not await — keep it off the critical path
    postReferral(payload).then((r) => {
      if (!r.ok) console.warn('[referrals] post failed', r);
      else if (DEBUG) console.log('[referrals] posted', r.data);
    }).catch((e) => {
      console.warn('[referrals] error', e);
    });
  } catch (e) {
    console.warn('[referrals] build/send error', e);
  }
}
