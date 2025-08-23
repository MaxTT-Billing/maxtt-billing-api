// Node 18+ has global fetch; Node 24 is fine.

const BASE = process.env.REF_API_BASE_URL || ''
const KEY  = process.env.REF_WRITER_API_KEY || ''

function assertEnv() {
  if (!BASE) throw new Error('Missing REF_API_BASE_URL')
  if (!KEY)  throw new Error('Missing REF_WRITER_API_KEY')
}

/** Post a referral to the Seal & Earn API. */
export async function postReferral(payload, signal) {
  assertEnv()

  const res = await fetch(`${BASE}/referrals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-REF-API-KEY': KEY
    },
    body: JSON.stringify(payload),
    signal
  })

  if (res.status === 409) {
    return { ok: true, duplicate: true }
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try { detail = JSON.stringify(await res.json()) } catch {}
    throw new Error(`Referrals API error: ${detail}`)
  }

  const data = await res.json()
  return { ok: true, duplicate: false, data }
}
