// referralsClient.js — tiny client to call Seal & Earn (Referrals API)

const BASE = process.env.REF_API_BASE_URL;
const DEFAULT_TIMEOUT = Number(process.env.REF_TIMEOUT_MS || 1500);

function timeoutAbort(ms = DEFAULT_TIMEOUT) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, cancel: () => clearTimeout(id) };
}

/**
 * Post a referral to Seal & Earn.
 * @param {object} payload {referrer_customer_code, referred_invoice_code, franchisee_code, invoice_amount_inr, invoice_date}
 * @param {string=} overrideKey optional key; otherwise uses REF_API_WRITER_KEY
 */
export async function postReferral(payload, overrideKey) {
  if (!BASE) return { ok: false, error: 'no_base_url' };
  const key = overrideKey || process.env.REF_API_WRITER_KEY;
  if (!key) return { ok: false, error: 'no_writer_key' };

  const { signal, cancel } = timeoutAbort();
  try {
    const res = await fetch(`${BASE}/referrals`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-REF-API-KEY': key,
      },
      body: JSON.stringify(payload),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    cancel();
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    cancel();
    return { ok: false, error: String(e?.message || e) };
  }
}
