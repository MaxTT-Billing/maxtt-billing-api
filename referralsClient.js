// referralsClient.js — Billing-side client for Referrals API (ESM)
// Uses HMAC (X-REF-SIG) with REF_SIGNING_KEY
// Env:
//   REF_API_BASE_URL (default: https://maxtt-referrals-api-pv5c.onrender.com)
//   REF_SIGNING_KEY  (must match referrals-api; TEMP ok: TS!MAXTT-2025)
//   REFERRALS_TIMEOUT_MS (default 5000)

import crypto from 'node:crypto';

const BASE = process.env.REF_API_BASE_URL || 'https://maxtt-referrals-api-pv5c.onrender.com';
const KEY  = process.env.REF_SIGNING_KEY || 'TS!MAXTT-2025';
const TIMEOUT_MS = Number(process.env.REFERRALS_TIMEOUT_MS || 5000);

function hmac(body) {
  const mac = crypto.createHmac('sha256', KEY);
  mac.update(JSON.stringify(body));
  return `sha256=${mac.digest('hex')}`;
}

async function _post(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-REF-SIG': hmac(body),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => '');
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { ok:false, error:'bad_json', raw:text }; }
    return { status: r.status, ok: r.ok, data: json };
  } finally {
    clearTimeout(t);
  }
}

/** Validate a referral code (non-fatal — caller may ignore failure) */
export async function validateReferral(code) {
  if (!code) return { ok:false, error:'empty_code' };
  const body = { code };
  return _post('/api/referrals/validate', body);
}

/** Credit a referral after invoice commit */
export async function creditReferral({ invoiceId, customerCode, refCode, subtotal, gst, litres, createdAt }) {
  const body = { invoiceId, customerCode, refCode, subtotal, gst, litres, createdAt };
  return _post('/api/referrals/credit', body);
}
