// referralsClient.js  (ESM)
// Extract referral code + POST to Seal & Earn with robust fallback.

const SE_BASE = (process.env.SEAL_EARN_BASE_URL || "").replace(/\/+$/,"");
const SE_KEY  = process.env.SEAL_EARN_API_KEY || "";

/** Extract a plausible referral code from free text. */
export function extractReferralCode(txt) {
  if (!txt || typeof txt !== "string") return null;
  const m1 = txt.match(/REF[:\s-]*([A-Za-z0-9/_-]{6,})/i);
  if (m1 && m1[1]) return m1[1].trim();
  const m2 = txt.match(/(MAXTT-[A-Z0-9/_-]{4,})/i);
  if (m2 && m2[1]) return m2[1].trim();
  const m3 = txt.match(/([A-Za-z0-9/_-]{8,})/);
  if (m3 && m3[1]) return m3[1].trim();
  return null;
}

function buildPayload(p) {
  return {
    referral_code:  String(p.referral_code || "").trim(),
    customer_code:  String(p.customer_code || "").trim(),
    invoice_id:     Number(p.invoice_id || 0),
    invoice_number: String(p.invoice_number || "").trim(),
    amount:         Number(p.amount || 0),
    created_at:     p.created_at || new Date().toISOString(),
    franchisee_id:  p.franchisee_id ? String(p.franchisee_id).trim() : undefined
  };
}

async function tryPost(url, payload, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const ok = res && res.ok;
    return { ok, status: res?.status ?? 0 };
  } catch (e) {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

/** Fire-and-forget POST to Seal & Earn with external → local fallback. */
export async function postReferral(p) {
  try {
    if (!p || !p.referral_code) return { ok: false, reason: "no_referral_code" };
    if (!SE_KEY) return { ok: false, reason: "env_missing_key" };

    const payload = buildPayload(p);
    const port = process.env.PORT || 10000;
    const local = `http://127.0.0.1:${port}/api/referrals`;

    // Try external first if configured; then local stub.
    const targets = [];
    if (SE_BASE) targets.push(SE_BASE + "/api/referrals");
    targets.push(local);

    // External: 3500ms; Local: 1500ms
    for (const url of targets) {
      const isLocal = url.startsWith("http://127.0.0.1:");
      const r = await tryPost(url, payload, isLocal ? 1500 : 3500);
      if (r.ok) return r;
    }
    return { ok: false, status: 0 };
  } catch (err) {
    return { ok: false, reason: "exception" };
  }
}
