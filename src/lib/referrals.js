// src/lib/referrals.js
// Client for Seal & Earn service (validate + credit)

import crypto from "node:crypto";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

const BASE_URL = required("REF_API_BASE_URL");            // e.g. https://maxtt-referrals-api-pv5c.onrender.com
const SIGNING_KEY = required("REF_SIGNING_KEY");          // 32+ chars secret
const TIMEOUT_MS = parseInt(process.env.REF_TIMEOUT_MS ?? "5000", 10);

function hmacHeader(payload) {
  const mac = crypto.createHmac("sha256", SIGNING_KEY);
  mac.update(JSON.stringify(payload));
  return `sha256=${mac.digest("hex")}`;
}

async function post(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ref-sig": hmacHeader(body),
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

// --- Public API ---

/**
 * Validate referral code.
 * @param {string} code
 * @returns {Promise<{valid: boolean, ownerName?: string}>}
 */
export async function validateReferralCode(code) {
  if (!code) return { valid: false };
  return post("/api/referrals/validate", { code });
}

/**
 * Credit referral after invoice commit.
 * @param {object} payload
 *   invoiceId, customerCode, refCode, subtotal, gst, litres, createdAt
 * @returns {Promise<any>}
 */
export async function creditReferral(payload) {
  return post("/api/referrals/credit", payload);
}
