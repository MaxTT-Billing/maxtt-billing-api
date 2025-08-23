const { postReferral } = require('./referralsClient');

const ENABLED    = (process.env.REFERRALS_ENABLED ?? 'true').toLowerCase() === 'true';
const TIMEOUT_MS = Number(process.env.REFERRALS_TIMEOUT_MS ?? 4500);

/** Call after your invoice is saved. Safe to call multiple times for same invoice_code. */
async function notifyReferralForInvoice(inv) {
  try {
    if (!ENABLED) return;

    if (!inv.referrerCustomerCode || !inv.franchiseeCode) return; // skip if missing

    const payload = {
      referrer_customer_code: inv.referrerCustomerCode,
      referred_invoice_code:  inv.invoiceCode,
      franchisee_code:        inv.franchiseeCode,
      invoice_amount_inr:     Number(inv.invoiceAmountInr),
      invoice_date:           String(inv.invoiceDateIso).slice(0, 10)
    };

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);

    const res = await postReferral(payload);
    clearTimeout(t);

    if (res.duplicate) console.info('[referrals] duplicate', payload.referred_invoice_code);
    else               console.info('[referrals] created', res.data?.id ?? '?', payload.referred_invoice_code);
  } catch (err) {
    console.warn('[referrals] notify failed:', err?.message || String(err));
  }
}

module.exports = { notifyReferralForInvoice };
