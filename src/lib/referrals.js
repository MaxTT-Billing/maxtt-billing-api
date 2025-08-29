// src/lib/referrals.js
// ESM module. Minimal client for Seal & Earn.
// Uses existing env: REF_API_BASE_URL
// Adds: REF_SIGNING_KEY (required), REF_TIMEOUT_MS (optional)

import crypto from "node:crypto";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

const BASE_URL = required("REF_API_BASE_URL");             // e.g., https://maxtt-referrals-api-pv5c.onrender.com
const SIGNING_KEY = required("REF_SIGNING_KEY");           // 32+ chars shared secret
const TIMEOUT_MS = parseInt(process.env.REF_TIMEOUT_MS ?? "5000", 10); // optional

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

export async function validateReferralCode(code) {
  if (!code) return { valid: false };
  return post("/api/referrals/validate", { code });
}

export async function creditReferral(payload) {
  // expected: { invoiceId, customerCode, refCode, subtotal, gst, litres, createdAt }
  return post("/api/referrals/credit", payload);
}
