// referralsClient.js  (ESM)
// Purpose: Extract a referral code from free text (e.g., "REF: MAXTT-DEL-001/XX/0042/0825")
// and POST a referral event to the Seal & Earn system without blocking invoice save.

const SE_BASE = process.env.SEAL_EARN_BASE_URL || "";
const SE_KEY  = process.env.SEAL_EARN_API_KEY  || "";

/** Extract a plausible referral code from remarks/free text. */
export function extractReferralCode(txt) {
  if (!txt || typeof txt !== "string") return null;

  // 1) Explicit REF: <code>
  const m1 = txt.match(/REF[:\s-]*([A-Za-z0-9/_-]{6,})/i);
  if (m1 && m1[1]) return m1[1].trim();

  // 2) Any MAXTT-* style token (letters/digits/slash/dash underscores)
  const m2 = txt.match(/(MAXTT-[A-Z0-9/_-]{4,})/i);
  if (m2 && m2[1]) return m2[1].trim();

  // 3) Fallback: first long token (8+ chars) with / or -
  const m3 = txt.match(/([A-Za-z0-9/_-]{8,})/);
  if (m3 && m3[1]) return m3[1].trim();

  return null;
}

/** Fire-and-forget POST to Seal & Earn (returning a small status object). */
export async function postReferral(payload) {
  try {
    if (!payload || !payload.referral_code) {
      return { ok: false, reason: "no_referral_code" };
    }
    if (!SE_BASE || !SE_KEY) {
      console.warn("[Seal&Earn] Missing SEAL_EARN_BASE_URL or SEAL_EARN_API_KEY, skipping.");
      return { ok: false, reason: "env_missing" };
    }

    // Build request
    const url = SE_BASE.replace(/\/+$/,"") + "/api/referrals";
    const body = {
      referral_code:  String(payload.referral_code || "").trim(),
      customer_code:  String(payload.customer_code || "").trim(),
      invoice_id:     Number(payload.invoice_id || 0),
      invoice_number: String(payload.invoice_number || "").trim(),
      amount:         Number(payload.amount || 0),
      created_at:     payload.created_at || new Date().toISOString(),
      franchisee_id:  payload.franchisee_id ? String(payload.franchisee_id).trim() : undefined
    };

    // Short timeout so we never block invoice save
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    }).catch((e) => {
      console.warn("[Seal&Earn] fetch error:", e?.name || e?.message || e);
      return { ok: false, status: 0 };
    });

    clearTimeout(t);

    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      console.warn("[Seal&Earn] non-OK:", status);
      return { ok: false, status };
    }

    return { ok: true };
  } catch (err) {
    console.warn("[Seal&Earn] unexpected error:", err?.message || err);
    return { ok: false, reason: "exception" };
  }
}
