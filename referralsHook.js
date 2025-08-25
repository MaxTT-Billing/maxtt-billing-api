// referralsHook.js — capture & normalize referral codes, then post to Seal & Earn
// Works without changing your DB schema. Reads transient fields passed from server.js.

import { postReferral } from './referralsClient.js';

const ON = process.env.REF_ENABLE === '1';
const DEBUG = process.env.REF_DEBUG === '1';
const MIN_DIGITS = Number(process.env.REF_INVOICE_MIN_DIGITS || '4');

// pick first non-empty
const pick = (obj, keys = []) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};

function toISODateOnly(x) {
  if (!x) return undefined;
  try {
    const d = new Date(x);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

function padSerial(n) {
  const s = String(n || '').trim();
  if (!s) return '';
  return /^\d+$/.test(s) ? s.padStart(MIN_DIGITS, '0') : s;
}

// Extract franchisee + serial from a full printed invoice like
// MAXTT-DEL-001/XX/0055/0825  (tail 0825 is MMYY)
function parseFullPrintedInvoice(str) {
  if (!str) return null;
  const s = String(str).trim();
  const parts = s.split('/').map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const fran = parts[0].toUpperCase();

  // detect MMYY tail
  const last = parts[parts.length - 1];
  const hasMMYY = /^(0[1-9]|1[0-2])\d{2}$/.test(last);
  const searchParts = hasMMYY ? parts.slice(1, -1) : parts.slice(1);

  // pick rightmost numeric, prefer 4–6 digits if available
  let serial = '';
  for (let i = searchParts.length - 1; i >= 0; i--) {
    const seg = searchParts[i];
    if (/^\d+$/.test(seg)) { serial = seg; break; }
  }
  if (!serial) return null;

  return { fran, serial: padSerial(serial) };
}

// Normalize any input into canonical FRAN-####
// Accepted inputs:
//  - full printed invoice (with slashes)
//  - FRAN-#### (canonical)
//  - ####@FRAN (convenience)
function normalizeReferralInput(input) {
  if (!input) return null;
  const raw = String(input).trim();

  // full printed (contains '/')
  if (raw.includes('/')) {
    const parsed = parseFullPrintedInvoice(raw);
    if (!parsed) return null;
    return `${parsed.fran}-${parsed.serial}`;
  }

  // FRAN-#### (last hyphen + digits)
  const m1 = raw.match(/^(.+)-(\d{1,10})$/);
  if (m1) {
    const fran = m1[1].trim().toUpperCase();
    const serial = padSerial(m1[2]);
    if (!fran || !/^\d+$/.test(m1[2])) return null;
    return `${fran}-${serial}`;
  }

  // ####@FRAN
  const m2 = raw.match(/^(\d{1,10})@(.+)$/);
  if (m2) {
    const fran = m2[2].trim().toUpperCase();
    const serial = padSerial(m2[1]);
    return `${fran}-${serial}`;
  }

  return null;
}

// Try to extract a code-looking string from free text (remarks) and normalize it
function extractFromRemarks(remarks) {
  if (!remarks) return null;
  const text = String(remarks);

  // 1) look for a full printed invoice (with slashes)
  const candidates1 = text.match(/[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+){1,6}/g);
  if (candidates1) {
    for (const c of candidates1) {
      const n = normalizeReferralInput(c);
      if (n) return n;
    }
  }

  // 2) look for FRAN-#### (last hyphen-digits)
  const m = text.match(/([A-Za-z0-9-]+)-(\d{1,10})/);
  if (m) {
    const fran = m[1].toUpperCase();
    const serial = padSerial(m[2]);
    return `${fran}-${serial}`;
  }
  return null;
}

// Build canonical code for the NEW invoice (the "referred" one)
function buildCanonicalForNewInvoice(inv) {
  // first, if invoice_number looks like a full printed invoice, parse it
  const invNum = pick(inv, ['invoice_number', 'invoice_no', 'inv_no', 'bill_no']);
  if (invNum && String(invNum).includes('/')) {
    const parsed = parseFullPrintedInvoice(invNum);
    if (parsed) return `${parsed.fran}-${parsed.serial}`;
  }

  // otherwise, compose from known fields
  const fran = (pick(inv, ['franchisee_code', 'franchise_code', '__franchisee_hint']) || '').toUpperCase().trim();
  const serialRaw = pick(inv, ['invoice_number', 'invoice_no', 'inv_no', 'bill_no', 'id']);
  if (!fran || !serialRaw) return null;

  const serial = padSerial(String(serialRaw).match(/\d+/)?.[0] || serialRaw);
  if (!serial) return null;

  return `${fran}-${serial}`;
}

/**
 * Convert an invoice + transient fields to the referral payload.
 * The invoice object MAY include:
 *   __raw_referral_code  (from body.referral_code_raw)
 *   __remarks            (from body.remarks/notes/etc)
 *   __franchisee_hint    (from body.franchisee_code)
 */
export function buildReferralFromInvoice(inv) {
  // 1) capture referrer's code (canonical)
  const raw = pick(inv, ['__raw_referral_code', 'referral_code_raw', 'referral_code']);
  let referrerCode = normalizeReferralInput(raw);
  if (!referrerCode) {
    referrerCode = extractFromRemarks(pick(inv, ['__remarks', 'remarks', 'notes', 'comment']));
  }

  // 2) canonical for the new invoice (the referred one)
  const referredCode = buildCanonicalForNewInvoice(inv);

  // 3) basic fields
  const franFromNew = (referredCode || '').split('-')[0] || pick(inv, ['franchisee_code', 'franchise_code']);
  let invoice_amount_inr =
    pick(inv, ['total_with_gst', 'total_amount', 'grand_total']);
  if (invoice_amount_inr === undefined) {
    const sub = Number(pick(inv, ['total_before_gst', 'subtotal_ex_gst', 'subtotal', 'amount_before_tax']) || 0);
    const gst = Number(pick(inv, ['gst_amount', 'tax_amount', 'gst_value']) || 0);
    invoice_amount_inr = sub + gst;
  }
  const amt = Number(invoice_amount_inr || 0);
  const invoice_date = toISODateOnly(
    pick(inv, ['created_at', 'invoice_date', 'date', 'createdon', 'created_on'])
  );

  return {
    referrer_customer_code: referrerCode || '',
    referred_invoice_code: referredCode || '',
    franchisee_code: String(franFromNew || '').toUpperCase(),
    invoice_amount_inr: Number.isFinite(amt) ? Number(amt.toFixed(2)) : undefined,
    invoice_date,
  };
}

/**
 * Fire-and-forget sender. Never throws; never blocks the API response.
 */
export function sendForInvoice(inv) {
  if (!ON) { DEBUG && console.log('[referrals] disabled (REF_ENABLE!=1)'); return; }

  try {
    const payload = buildReferralFromInvoice(inv);
    const missing = [];
    if (!payload.referrer_customer_code) missing.push('referrer_customer_code');
    if (!payload.referred_invoice_code)  missing.push('referred_invoice_code');
    if (!payload.franchisee_code)        missing.push('franchisee_code');
    if (!payload.invoice_amount_inr)     missing.push('invoice_amount_inr');
    if (!payload.invoice_date)           missing.push('invoice_date');

    if (missing.length) {
      DEBUG && console.warn('[referrals] skip; missing:', missing, { note: 'add referral_code_raw or REF: ... in remarks' });
      return;
    }

    postReferral(payload).then((r) => {
      if (!r.ok) console.warn('[referrals] post failed', r);
      else if (DEBUG) console.log('[referrals] posted', r.data);
    }).catch((e) => {
      console.warn('[referrals] error', e);
    });
  } catch (e) {
    console.warn('[referrals] build/send error', e);
  }
}
