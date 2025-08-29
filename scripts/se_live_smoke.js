// scripts/se_live_smoke.js
// Quick SE-LIVE smoke test from the billing API environment.
// Usage: node scripts/se_live_smoke.js

import "dotenv/config";

const BASE   = process.env.REF_API_BASE_URL;
const KEY    = process.env.REF_SIGNING_KEY;
const TIMEOUT= parseInt(process.env.REFERRALS_TIMEOUT_MS ?? "5000", 10);

if (!BASE || !KEY) {
  console.error("Missing REF_API_BASE_URL or REF_SIGNING_KEY");
  process.exit(1);
}

import crypto from "node:crypto";
function hmac(body) {
  const mac = crypto.createHmac("sha256", KEY);
  mac.update(JSON.stringify(body));
  return `sha256=${mac.digest("hex")}`;
}

async function post(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
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
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    return { status: 0, text: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  console.log("=== SE-LIVE Smoke: validate ===");
  const v = await post("/api/referrals/validate", { code: "MAXTT-DEL-0087" });
  console.log("validate:", v.status, v.text);

  console.log("\n=== SE-LIVE Smoke: credit ===");
  const payload = {
    invoiceId: 12345,
    customerCode: "TS-DL-DEL-001-0001",
    refCode: "MAXTT-DEL-0087",
    subtotal: 1000,
    gst: 180,
    litres: 2.0,
    createdAt: new Date().toISOString(),
  };
  const c = await post("/api/referrals/credit", payload);
  console.log("credit:", c.status, c.text);
})();
