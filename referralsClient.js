// referralsClient.js
// HTTP client for Seal & Earn (validate + credit) using HMAC auth.
// Uses: REF_API_BASE_URL, REF_SIGNING_KEY, REFERRALS_TIMEOUT_MS (optional)

import crypto from "node:crypto";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

const BASE = required("REF_API_BASE_URL");                 // e.g. https://maxtt-referrals-api-pv5c.onrender.com
const KEY  = required("REF_SIGNING_KEY");                  // 32+ char shared secret
const TIMEOUT = parseInt(process.env.REFERRALS_TIMEOUT_MS ?? "5000", 10);

function hmac(body) {
  const mac = crypto.createHmac("sha256", KEY);
  mac.update(JSON.stringify(body));
  return `sha256=${mac.digest("hex")}`;
}

async function post(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ref-sig": hmac(body),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Referrals ${path} ${res.status}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate a referral code
 * @param {string} code
 * @returns {Promise<{valid:boolean, ownerName?:string}>}
 */
export async function validateReferral(code) {
  if (!code) return { valid: false };
  return post("/api/referrals/validate", { code });
}

/**
 * Credit a referral based on invoice facts (post-commit)
 * Shape: { invoiceId, customerCode, refCode, subtotal, gst, litres, createdAt }
 */
export async function creditReferral(payload) {
  return post("/api/referrals/credit", payload);
}

/**
 * Legacy/test passthrough retained for /__wire/referrals/test
 * Accepts an already-shaped body + apiKey header fallback.
 */
export async function postReferral(body /*, apiKey */) {
  // Normalise into credit payload if fields look like legacy names
  const maybe = {
    invoiceId: body.referred_invoice_code ?? body.invoiceId,
    customerCode: body.customer_code ?? body.customerCode,
    refCode: body.referrer_customer_code ?? body.refCode,
    subtotal: body.invoice_amount_inr ?? body.subtotal,
    gst: body.gst ?? 0,
    litres: body.litres ?? body.total_qty_ml ?? 0,
    createdAt: body.invoice_date ?? body.createdAt,
  };
  return creditReferral(maybe);
}
