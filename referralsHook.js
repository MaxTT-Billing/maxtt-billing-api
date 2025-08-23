const { postReferral } = require('./referralsClient');

const ENABLED    = (process.env.REFERRALS_ENABLED ?? 'true').toLowerCase() === 'true';
const TIMEOUT_MS = Number(process.env.REFERRALS_TIMEOUT_MS ?? 4500);

/**
 * Call this AFTER your invoice is saved/committed.
 * It’s safe to call multiple times: server enforces unique(referred_invoice_code).
 *
 * @param {{
 *  referrerCustomerCode?: string|null,
 *  invoiceCode: string,
 *  franchiseeCode?: string|null,
 *  invoiceAmountInr: number,
 *  invoiceDateIso: string // "YYYY-MM-DD"
 * }} inv
 */
async function notifyReferralForInvoice(inv) {
  try {
    if (!ENABLED) return;

    // Skip when there is no referral context
    if (!inv?.referrerCustomerCode || !inv?.franchiseeCode) return;

    const payload = {
      referrer_customer_code: String(inv.referrerCustomerCode),
      referred_invoice_code:  String(inv.invoiceCode),
      franchisee_code:        String(inv.franchiseeCode),
      invoice_amount_inr:     Number(inv.invoiceAmountInr),
      invoice_date:           String(inv.invoiceDateIso).slice(0, 10)
    };

    // Optional timeout
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    const res = await postReferral(payload, ac.signal);
    clearTimeout(timer);

    if (res.duplicate) {
      console.info('[referrals] duplicate', payload.referred_invoice_code);
    } else {
      console.info('[referrals] created', res.data?.id ?? '?', payload.referred_invoice_code);
    }
  } catch (err) {
    console.warn('[referrals] notify failed:', err?.message || String(err));
  }
}

module.exports = { notifyReferralForInvoice };
