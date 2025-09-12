// server.js — MaxTT Billing API (ESM)
// Baseline + v46 PDF + Installations (stock lock) + AUTH (F1)
// + F2 (auto-seed + /me/stock) + Strict Actuals /me/summary
// + Baseline control: SA can set onboarded_at; summary caps to it

import express from 'express';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

import { createV46Pdf } from './pdf/invoice_v46.js';
import adminLatestInvoicesRouter from './routes/admin.latest.invoices.js';
import installationsRouter from './routes/installations.js';

const app = express();

// ------------------------------- CORS ---------------------------------
const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://maxtt-billing-frontend.onrender.com,https://maxtt-billing-tools.onrender.com'
).split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-REF-API-KEY, X-SA-KEY, X-ADMIN-KEY, X-SA-USER, X-ADMIN-USER, X-FRANCHISEE-KEY, X-FRANCHISEE-TOKEN'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ------------------------------- Routers -------------------------------
app.use('/api/invoices/admin', adminLatestInvoicesRouter);

// Body parser before JSON POST routes.
app.use(express.json({ limit: '15mb' }));

// Stock-lock / installations routes
installationsRouter(app);

// ------------------------------- DB -----------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --------------------------- Helpers ----------------------------------
let cachedCols = null;
async function getInvoiceCols(client) {
  if (cachedCols) return cachedCols;
  const r = await client.query(`
    SELECT lower(column_name) AS name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices'
  `);
  cachedCols = new Set(r.rows.map(x => x.name));
  return cachedCols;
}
const has = (cols, n) => cols.has(String(n).toLowerCase());
const qid = n => `"${n}"`;
function findCol(cols, candidates) {
  for (const c of candidates) if (has(cols, c)) return c;
  return null;
}
const pad = (n, w = 4) => String(Math.max(0, Number(n) || 0)).padStart(w, '0');
function mmYY(d = new Date()) {
  const mm = String(d.getUTCMonth() + 1).toString().padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}${yy}`;
}
function printedFromNorm(norm) {
  if (!norm || typeof norm !== 'string') return null;
  const m = norm.match(/^(.*)-(\d{4})$/);
  if (!m) return null;
  const prefix = m[1], seq = m[2];
  return `${prefix}/${mmYY()}/${seq}`;
}

// -------------------------- Franchisee AUTH (F1) ----------------------
async function ensureFranchiseeAuthColumns() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE public.franchisees
      ADD COLUMN IF NOT EXISTS hashed_password TEXT
    `);
  } finally {
    client.release();
  }
}
ensureFranchiseeAuthColumns().catch(() => { /* non-fatal at boot */ });

const PW_ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
function generatePassword(len = 20) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PW_ALPH[bytes[i] % PW_ALPH.length];
  return `${out.slice(0,5)}-${out.slice(5,10)}-${out.slice(10,15)}-${out.slice(15,20)}`;
}

function scryptHash(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1, keylen = 64;
  const dk = crypto.scryptSync(password, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
function scryptVerify(password, stored) {
  try {
    const [alg, Ns, rs, ps, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const N = Number(Ns), r = Number(rs), p = Number(ps);
    const salt = Buffer.from(saltB64, 'base64');
    const keylen = Buffer.from(hashB64, 'base64').length;
    const dk = crypto.scryptSync(password, salt, keylen, { N, r, p });
    return crypto.timingSafeEqual(dk, Buffer.from(hashB64, 'base64'));
  } catch { return false; }
}

const AUTH_SECRET = process.env.AUTH_SECRET || '';
const TOKEN_TTL_HOURS = Number(process.env.TOKEN_TTL_HOURS || 8);
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function signToken(franchisee_id, hours = TOKEN_TTL_HOURS) {
  if (!AUTH_SECRET) throw new Error('auth_secret_not_set');
  const exp = Math.floor(Date.now()/1000) + Math.max(1, hours)*3600;
  const payload = JSON.stringify({ sub: String(franchisee_id), exp });
  const p64 = b64url(payload);
  const toSign = `v1.${p64}`;
  const sig = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(toSign).digest());
  return `${toSign}.${sig}`;
}
function verifyToken(token) {
  try {
    const [v, p64, sig] = String(token || '').split('.');
    if (v !== 'v1' || !p64 || !sig) return null;
    const expect = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(`${v}.${p64}`).digest());
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const json = Buffer.from(p64.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
    const obj = JSON.parse(json);
    if (!obj || !obj.sub || !obj.exp) return null;
    if (Math.floor(Date.now()/1000) > Number(obj.exp)) return null;
    return { franchisee_id: String(obj.sub) };
  } catch { return null; }
}

function requireKey(header, envName) {
  return (req, res, next) => {
    const key = req.get(header) || '';
    const expect = process.env[envName] || '';
    if (!expect) return res.status(500).json({ ok: false, error: `${envName.toLowerCase()}_not_set` });
    if (key !== expect) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  };
}
const requireSA = requireKey('X-SA-KEY', 'SUPER_ADMIN_KEY');

function requireFranchisee(req, res, next) {
  const auth = req.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const alt = req.get('X-FRANCHISEE-TOKEN') || '';
  const token = bearer || alt;
  if (!AUTH_SECRET) return res.status(500).json({ ok: false, code: 'auth_secret_not_set' });
  const parsed = verifyToken(token);
  if (!parsed) return res.status(401).json({ ok: false, code: 'unauthorized' });
  req.franchisee_id = parsed.franchisee_id;
  next();
}

// ------------------------------- Health --------------------------------
app.get('/', (_req, res) => res.send('MaxTT Billing API is running'));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ------------------------------- AUTH F1 --------------------------------
app.post('/admin/franchisees/reset-password/:id', requireSA, async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, code: 'bad_id' });
  const client = await pool.connect();
  try {
    await ensureFranchiseeAuthColumns();
    const pw = generatePassword(20);
    const hashed = scryptHash(pw);
    const q = await client.query(
      `UPDATE public.franchisees SET hashed_password=$2, updated_at=NOW()
         WHERE id=$1
     RETURNING franchisee_id`,
      [id, hashed]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, code: 'not_found' });
    const fr_id = q.rows[0].franchisee_id || null;
    return res.status(200).json({ ok: true, franchisee_id: fr_id, password: pw });
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'reset_failed', message: e?.message || String(e) });
  } finally {
    client.release();
  }
});

app.post('/admin/franchisees/reset-password/by-franchisee-id/:franchisee_id', requireSA, async (req, res) => {
  const frid = String(req.params.franchisee_id || '').trim();
  if (!frid) return res.status(400).json({ ok: false, code: 'missing_franchisee_id' });
  const client = await pool.connect();
  try {
    await ensureFranchiseeAuthColumns();
    const pw = generatePassword(20);
    const hashed = scryptHash(pw);
    const q = await client.query(
      `UPDATE public.franchisees SET hashed_password=$2, updated_at=NOW()
         WHERE franchisee_id=$1
     RETURNING franchisee_id`,
      [frid, hashed]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, code: 'not_found' });
    return res.status(200).json({ ok: true, franchisee_id: frid, password: pw });
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'reset_failed', message: e?.message || String(e) });
  } finally {
    client.release();
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  const { franchisee_id, password } = req.body || {};
  if (!franchisee_id || !password) return res.status(400).json({ ok: false, code: 'invalid_input' });
  if (!AUTH_SECRET) return res.status(500).json({ ok: false, code: 'auth_secret_not_set' });

  const client = await pool.connect();
  try {
    const q = await client.query(
      `SELECT id, franchisee_id, hashed_password
         FROM public.franchisees
        WHERE franchisee_id=$1
        LIMIT 1`,
      [String(franchisee_id)]
    );
    if (!q.rowCount) return res.status(401).json({ ok: false, code: 'bad_credentials' });
    const row = q.rows[0];
    if (!row.hashed_password) return res.status(403).json({ ok: false, code: 'password_not_set' });

    const ok = scryptVerify(String(password), row.hashed_password);
    if (!ok) return res.status(401).json({ ok: false, code: 'bad_credentials' });

    const token = signToken(row.franchisee_id, TOKEN_TTL_HOURS);
    const expires_at = new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
    return res.status(200).json({ ok: true, token, franchisee_id: row.franchisee_id, expires_at });
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'login_failed', message: e?.message || String(e) });
  } finally {
    client.release();
  }
});

// Test token
app.get('/me/ping', requireFranchisee, (req, res) => {
  res.status(200).json({ ok: true, franchisee_id: req.franchisee_id });
});

// --------------------- F2: My stock (token-protected) ------------------
const INV_TABLE = process.env.INVENTORY_TABLE || 'inventory';
const INV_FR_COL = process.env.INVENTORY_FRANCHISEE_COL || 'franchisee_id';
const INV_STOCK_COL = process.env.INVENTORY_STOCK_COL || 'available_litres';
const INITIAL_STOCK_LITRES = Number(process.env.INITIAL_STOCK_LITRES || 120);

app.get('/me/stock', requireFranchisee, async (req, res) => {
  const client = await pool.connect();
  try {
    const frid = req.franchisee_id;
    const r = await client.query(
      `SELECT ${qid(INV_STOCK_COL)} AS stock
         FROM public.${qid(INV_TABLE)}
        WHERE ${qid(INV_FR_COL)}=$1
        LIMIT 1`,
      [frid]
    );
    const stock = r.rowCount ? Number(r.rows[0].stock) : 0;
    res.status(200).json({ ok: true, franchisee_id: frid, available_litres: stock });
  } catch (e) {
    res.status(500).json({ ok: false, code: 'me_stock_failed', message: e?.message || String(e) });
  } finally {
    client.release();
  }
});

// --------------------- Baseline: set onboarded_at (SA) -----------------
const requireSA2 = requireKey('X-SA-KEY', 'SUPER_ADMIN_KEY');

// Set or update onboarded_at for a franchisee (by franchisee_id).
// Body: { "at": "<ISO timestamp>" }  // optional; defaults to now
app.post('/api/super/franchisees/set-onboarded-at/:franchisee_id', requireSA2, async (req, res) => {
  const frid = String(req.params.franchisee_id || '').trim();
  if (!frid) return res.status(400).json({ ok: false, error: 'missing_franchisee_id' });
  const atStr = (req.body?.at || '').toString().trim();
  let when = new Date();
  if (atStr) {
    const d = new Date(atStr);
    if (isNaN(d.getTime())) return res.status(400).json({ ok: false, error: 'bad_timestamp' });
    when = d;
  }
  const client = await pool.connect();
  try {
    const r = await client.query(
      `UPDATE public.franchisees
         SET onboarded_at=$2, updated_at=NOW()
       WHERE franchisee_id=$1
       RETURNING franchisee_id, onboarded_at`,
      [frid, when.toISOString()]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'not_found' });
    res.status(200).json({ ok: true, franchisee_id: r.rows[0].franchisee_id, onboarded_at: r.rows[0].onboarded_at });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'set_onboarded_failed', message: e?.message || String(e) });
  } finally {
    client.release();
  }
});

// --------------------- F3 (Strict Actuals): /me/summary ----------------
const METRICS_TZ = process.env.METRICS_TZ || 'Asia/Kolkata';

// IST month bounds → UTC ISO strings, plus pretty +05:30 strings
function istMonthBounds(monthParam /* 'YYYY-MM' or undefined */) {
  const pad2 = n => String(n).padStart(2, '0');
  let y, m;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    y = Number(monthParam.slice(0,4));
    m = Number(monthParam.slice(5,7));
  } else {
    const now = new Date(Date.now() + 330 * 60 * 1000); // now in IST
    y = now.getUTCFullYear();
    m = now.getUTCMonth() + 1;
  }
  const startUtcMs = Date.UTC(y, m - 1, 1, -5, -30, 0);
  const endUtcMs   = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, -5, -30, 0);
  const startUtcIso = new Date(startUtcMs).toISOString();
  const endUtcIso   = new Date(endUtcMs).toISOString();

  const pad = n => String(n).padStart(2, '0');
  const monthStr = `${y}-${pad(m)}`;
  const startLocal = `${monthStr}-01T00:00:00+05:30`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const endLocal = `${nextY}-${pad(nextM)}-01T00:00:00+05:30`;
  return { monthStr, startUtcIso, endUtcIso, startLocal, endLocal, tz: 'Asia/Kolkata' };
}
function toIstLocalString(utcIso) {
  const d = new Date(utcIso);
  const ms = d.getTime() + 330 * 60 * 1000;
  const z = new Date(ms);
  const pad2 = n => String(n).padStart(2, '0');
  const yyyy = z.getUTCFullYear();
  const mm = pad2(z.getUTCMonth() + 1);
  const dd = pad2(z.getUTCDate());
  const hh = pad2(z.getUTCHours());
  const mi = pad2(z.getUTCMinutes());
  const ss = pad2(z.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+05:30`;
}

app.get('/me/summary', requireFranchisee, async (req, res) => {
  const client = await pool.connect();
  try {
    const frid = req.franchisee_id;
    const monthParam = String(req.query.month || '').trim() || undefined;
    const b = istMonthBounds(monthParam);

    // Fetch onboarded_at (baseline)
    const rFr = await client.query(
      `SELECT onboarded_at FROM public.franchisees WHERE franchisee_id=$1 LIMIT 1`,
      [frid]
    );
    const onboardedAtUtcIso = rFr.rowCount && rFr.rows[0].onboarded_at
      ? new Date(rFr.rows[0].onboarded_at).toISOString()
      : null;

    // Effective window start = max(month start, onboarded_at)
    let effStartUtcIso = b.startUtcIso;
    if (onboardedAtUtcIso && new Date(onboardedAtUtcIso) > new Date(b.startUtcIso)) {
      effStartUtcIso = onboardedAtUtcIso;
    }
    const effStartLocal = toIstLocalString(effStartUtcIso);

    // 1) Current stock
    const rStock = await client.query(
      `SELECT ${qid(INV_STOCK_COL)} AS stock
         FROM public.${qid(INV_TABLE)}
        WHERE ${qid(INV_FR_COL)}=$1
        LIMIT 1`,
      [frid]
    );
    const currentStock = rStock.rowCount ? Number(rStock.rows[0].stock) : 0;

    // 2) Vehicles & material used (Strict Actuals)
    const rInst = await client.query(
      `SELECT
          COUNT(*)::int AS vehicles,
          COALESCE(SUM(used_litres), 0)::float AS used_l
         FROM public.installations
        WHERE franchisee_id = $1
          AND status = 'completed'
          AND completed_at >= $2::timestamptz
          AND completed_at <  $3::timestamptz`,
      [frid, effStartUtcIso, b.endUtcIso]
    );
    const vehiclesThisMonth = rInst.rows[0]?.vehicles || 0;
    const materialUsedThisMonthL = Number(rInst.rows[0]?.used_l || 0);

    // 3) Material used to date (since onboarded_at if present)
    const rToDate = await client.query(
      `SELECT
          COALESCE(SUM(i.used_litres), 0)::float AS used_l
         FROM public.installations i
        WHERE i.franchisee_id = $1
          AND i.status = 'completed'
          AND ($2::timestamptz IS NULL OR i.completed_at >= $2::timestamptz)`,
      [frid, onboardedAtUtcIso]
    );
    const materialUsedToDateL = Number(rToDate.rows[0]?.used_l || 0);

    // 4) Sales & GST (created_at is TIMESTAMP WITHOUT TIME ZONE)
    const startNoTz = effStartUtcIso.replace('Z','');
    const endNoTz   = b.endUtcIso.replace('Z','');
    const rSales = await client.query(
      `SELECT
          COALESCE(SUM(total_with_gst), 0)::float AS sales,
          COALESCE(SUM(gst_amount), 0)::float AS gst,
          COUNT(*)::int AS invoices
         FROM public.invoices
        WHERE franchisee_id = $1
          AND created_at >= $2::timestamp
          AND created_at <  $3::timestamp`,
      [frid, startNoTz, endNoTz]
    );
    const salesThisMonth = Number(rSales.rows[0]?.sales || 0);
    const gstThisMonth = Number(rSales.rows[0]?.gst || 0);
    const invoicesThisMonth = rSales.rows[0]?.invoices || 0;

    // 5) Reconciliation: started but not completed in the effective window
    const rRecon = await client.query(
      `SELECT COUNT(*)::int AS pending
         FROM public.installations
        WHERE franchisee_id = $1
          AND status <> 'completed'
          AND created_at >= $2::timestamptz
          AND created_at <  $3::timestamptz`,
      [frid, effStartUtcIso, b.endUtcIso]
    );
    const needsReconciliation = rRecon.rows[0]?.pending || 0;

    res.status(200).json({
      ok: true,
      franchisee_id: frid,
      period: {
        month: b.monthStr,
        month_from_local: b.startLocal,
        month_to_local: b.endLocal,
        effective_from_local: effStartLocal,
        tz: METRICS_TZ
      },
      current_stock_l: currentStock,
      vehicles_this_month: vehiclesThisMonth,
      sales_this_month: salesThisMonth,
      gst_this_month: gstThisMonth,
      material_used_this_month_l: materialUsedThisMonthL,
      material_used_to_date_l: materialUsedToDateL,
      needs_reconciliation_count: needsReconciliation,
      computed_via: { material: 'installations_only', baseline_applied: Boolean(onboardedAtUtcIso) }
    });
  } catch (e) {
    res.status(500).json({ ok: false, code: 'me_summary_failed', message: e?.message || String(e) });
  } finally {
    client.release();
  }
});

// ---------------------- Invoices: create (schema-adaptive) -------------
app.post('/api/invoices/full', async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const franchisee_id = String(body.franchisee_id || body.franchiseeId || '').trim();
    const tyre_width_mm = Number(body.tyre_width_mm || 195);
    const rim_diameter_in = Number(body.rim_diameter_in || 15);
    const tyre_count = Number(body.tyre_count || 4);
    if (!franchisee_id) return res.status(400).json({ ok: false, error: 'missing_franchisee_id' });

    const DEFAULT_QTY_ML = Number(process.env.DEFAULT_QTY_ML || 1200);
    const MRP_PER_ML = Number(process.env.MRP_PER_ML || process.env.FALLBACK_MRP_PER_ML || 4.5);
    const total_before_gst = Math.round(DEFAULT_QTY_ML * MRP_PER_ML);
    const gst_amount = Math.round(total_before_gst * 0.18);
    const total_with_gst = total_before_gst + gst_amount;

    const cols = await getInvoiceCols(client);
    const fcol = findCol(cols, ['franchisee_id', 'franchisee_code']) || 'franchisee_id';
    const idCol = findCol(cols, ['id', 'invoice_id']) || 'id';

    const seqQ = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.invoices WHERE ${qid(fcol)}=$1`,
      [franchisee_id]
    );
    const seq = (seqQ.rows?.[0]?.c || 0) + 1;
    const seqStr = pad(seq, 4);
    const invoice_number_norm = `${franchisee_id}-${seqStr}`;
    const invoice_number_printed = `${franchisee_id}/${mmYY()}/${seqStr}`;

    const toInsert = {};
    toInsert[fcol] = franchisee_id;
    if (has(cols, 'invoice_number_norm')) toInsert['invoice_number_norm'] = invoice_number_norm;
    if (has(cols, 'invoice_number')) toInsert['invoice_number'] = invoice_number_printed;
    if (has(cols, 'tyre_count')) toInsert['tyre_count'] = tyre_count;
    if (has(cols, 'tyre_width_mm')) toInsert['tyre_width_mm'] = tyre_width_mm;
    if (has(cols, 'rim_diameter_in')) toInsert['rim_diameter_in'] = rim_diameter_in;
    if (has(cols, 'dosage_ml')) toInsert['dosage_ml'] = DEFAULT_QTY_ML;
    if (has(cols, 'price_per_ml')) toInsert['price_per_ml'] = MRP_PER_ML;
    if (has(cols, 'total_before_gst')) toInsert['total_before_gst'] = total_before_gst;
    if (has(cols, 'gst_amount')) toInsert['gst_amount'] = gst_amount;
    if (has(cols, 'total_with_gst')) toInsert['total_with_gst'] = total_with_gst;
    if (has(cols, 'hsn_code')) toInsert['hsn_code'] = '35069999';
    if (has(cols, 'gst_rate')) toInsert['gst_rate'] = 18;
    if (has(cols, 'created_at')) toInsert['created_at'] = new Date().toISOString();

    const columns = Object.keys(toInsert);
    const values = Object.values(toInsert);
    const params = values.map((_, i) => `$${i + 1}`).join(',');
    const sql = `INSERT INTO public.invoices (${columns.map(qid).join(',')}) VALUES (${params})
                 RETURNING ${qid(idCol)} AS id, "customer_code",
                 ${has(cols, 'invoice_number_norm') ? '"invoice_number_norm"' : 'NULL AS invoice_number_norm'},
                 ${has(cols, 'invoice_number') ? '"invoice_number"' : 'NULL AS invoice_number'}`;
    const r = await client.query(sql, values);

    const row = r.rows[0];
    const printed =
      row.invoice_number || printedFromNorm(row.invoice_number_norm) || invoice_number_printed;
    res.status(201).json({
      ok: true,
      id: row.id,
      invoice_number: printed,
      invoice_number_norm: row.invoice_number_norm || invoice_number_norm,
      customer_code: row.customer_code || invoice_number_norm,
      qty_ml_saved: Number(process.env.DEFAULT_QTY_ML || 1200),
    });
  } catch (err) {
    console.error('create_invoice error:', err);
    res.status(500).json({ ok: false, where: 'create_invoice', message: err?.message || String(err) });
  } finally {
    client.release();
  }
});

// ---------------------- Invoices: list / latest / full2 / by-norm ------
app.get('/api/invoices', async (req, res) => {
  const client = await pool.connect();
  try {
    const cols = await getInvoiceCols(client);
    const dcol = findCol(cols, ['id', 'invoice_id', 'created_at']) || 'id';
    const params = [];
    const where = [];
    if (req.query.franchisee_id) {
      where.push(`${qid('franchisee_id')} = $${params.length + 1}`);
      params.push(req.query.franchisee_id);
    }
    const sql = `
      SELECT i.*
      FROM public.invoices i
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY i.${qid(dcol)} DESC
      LIMIT ${Math.min(Number(req.query.limit || 500), 5000)}
    `;
    const r = await client.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ ok: false, where: 'list_invoices', message: err?.message || String(err) });
  } finally {
    client.release();
  }
});

app.get('/api/invoices/latest', async (_req, res) => {
  const client = await pool.connect();
  try {
    const cols = await getInvoiceCols(client);
    const idCol = findCol(cols, ['id', 'invoice_id']) || 'id';
    const r = await client.query(
      `SELECT ${qid(idCol)} AS id FROM public.invoices ORDER BY ${qid(idCol)} DESC LIMIT 1`
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'empty' });
    res.json({ id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, where: 'latest', message: err?.message || String(err) });
  } finally {
    client.release();
  }
});

app.get(['/api/invoices/:id/full2', '/invoices/:id/full2'], async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'bad_id' });
    const r = await client.query(`SELECT * FROM public.invoices WHERE id=$1 LIMIT 1`, [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
    res.setHeader('Cache-Control', 'no-store');
    const doc = r.rows[0];
    const printed =
      doc.invoice_number ||
      (doc.invoice_number_norm ? printedFromNorm(doc.invoice_number_norm) : null);
    res.json(printed ? { ...doc, invoice_number: printed } : doc);
  } catch (err) {
    res.status(500).json({ ok: false, where: 'get_invoice_full2', message: err?.message || String(err) });
  } finally {
    client.release();
  }
});

app.get('/api/invoices/by-norm/:norm', async (req, res) => {
  const client = await pool.connect();
  try {
    const norm = String(req.params.norm || '').trim();
    if (!norm) return res.status(400).json({ ok: false, error: 'missing_norm' });
    const r = await client.query(
      `SELECT * FROM public.invoices WHERE "invoice_number_norm"=$1 LIMIT 1`,
      [norm]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ ok: false, where: 'by_norm', message: err?.message || err });
  } finally {
    client.release();
  }
});

// -------------- Franchisee Onboarding (Admin/SA) + F2 seeding ----------
app.post('/api/super/franchisees/approve/:id', requireSA2, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'bad_id' });
    }
    const note = (req.body?.note || '').trim();
    const approver = (req.get('X-SA-USER') || 'superadmin').trim() || 'superadmin';
    const nowIso = new Date().toISOString();

    const r = await client.query(
      `
      UPDATE public.franchisees
      SET status='ACTIVE', approval_by=$2, approval_at=$3, approval_note=$4, rejection_reason=NULL
      WHERE id=$1 RETURNING *`,
      [id, approver, nowIso, note]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const frRow = r.rows[0];
    const frid = frRow.franchisee_id || frRow.code || null;

    let seeded_inventory_litres = 0;
    let inventory_after = null;

    if (frid) {
      const sel = await client.query(
        `SELECT ${qid(INV_STOCK_COL)} AS stock
           FROM public.${qid(INV_TABLE)}
          WHERE ${qid(INV_FR_COL)}=$1
          LIMIT 1`,
        [frid]
      );
      if (sel.rowCount === 0) {
        const initial = INITIAL_STOCK_LITRES;
        const ins = await client.query(
          `INSERT INTO public.${qid(INV_TABLE)} (${qid(INV_FR_COL)}, ${qid(INV_STOCK_COL)})
           VALUES ($1,$2)
           RETURNING ${qid(INV_STOCK_COL)} AS stock`,
          [frid, initial]
        );
        seeded_inventory_litres = initial;
        inventory_after = Number(ins.rows[0].stock);
      } else {
        inventory_after = Number(sel.rows[0].stock);
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, franchisee: frRow, seeded_inventory_litres, inventory_after });
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

// Approve by franchisee_id (string)
app.post('/api/super/franchisees/approve/by-franchisee-id/:franchisee_id', requireSA2, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const frid = String(req.params.franchisee_id || '').trim();
    if (!frid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'missing_franchisee_id' });
    }
    const note = (req.body?.note || '').trim();
    const approver = (req.get('X-SA-USER') || 'superadmin').trim() || 'superadmin';
    const nowIso = new Date().toISOString();

    const r = await client.query(
      `
      UPDATE public.franchisees
      SET status='ACTIVE', approval_by=$2, approval_at=$3, approval_note=$4, rejection_reason=NULL
      WHERE franchisee_id=$1
      RETURNING *`,
      [frid, approver, nowIso, note]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const frRow = r.rows[0];

    let seeded_inventory_litres = 0;
    let inventory_after = null;

    const sel = await client.query(
      `SELECT ${qid(INV_STOCK_COL)} AS stock
         FROM public.${qid(INV_TABLE)}
        WHERE ${qid(INV_FR_COL)}=$1
        LIMIT 1`,
      [frid]
    );
    if (sel.rowCount === 0) {
      const initial = INITIAL_STOCK_LITRES;
      const ins = await client.query(
        `INSERT INTO public.${qid(INV_TABLE)} (${qid(INV_FR_COL)}, ${qid(INV_STOCK_COL)})
         VALUES ($1,$2)
         RETURNING ${qid(INV_STOCK_COL)} AS stock`,
        [frid, initial]
      );
      seeded_inventory_litres = initial;
      inventory_after = Number(ins.rows[0].stock);
    } else {
      inventory_after = Number(sel.rows[0].stock);
    }

    await client.query('COMMIT');
    res.json({ ok: true, franchisee: frRow, seeded_inventory_litres, inventory_after });
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

app.post('/api/super/franchisees/reject/:id', requireSA2, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'bad_id' });
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ ok: false, error: 'missing_reason' });
    const approver = (req.get('X-SA-USER') || 'superadmin').trim() || 'superadmin';
    const nowIso = new Date().toISOString();
    const r = await client.query(
      `
      UPDATE public.franchisees
      SET status='REJECTED', approval_by=$2, approval_at=$3, rejection_reason=$4, approval_note=NULL
      WHERE id=$1 RETURNING *`,
      [id, approver, nowIso, reason]
    );
    res.json({ ok: true, franchisee: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

// ------------------------------- PDF (v46 exact) -----------------------
app.get('/api/invoices/:id/pdf', async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  const download = String(req.query.download || '').trim() === '1';

  const client = await pool.connect();
  try {
    const ir = await client.query(`SELECT * FROM public.invoices WHERE id=$1 LIMIT 1`, [id]);
    if (!ir.rows.length) return res.status(404).json({ error: 'not_found' });
    const inv = ir.rows[0];

    const frCode = inv.franchisee_id || inv.franchisee_code || '';
    let fr = null;
    if (frCode) {
      const frq = await client.query(`SELECT * FROM public.franchisees WHERE code=$1 LIMIT 1`, [
        frCode,
      ]);
      fr = frq.rows[0] || null;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="invoice-${id}.pdf"`
    );
    await createV46Pdf(res, inv, fr);
  } catch (e) {
    res.status(500).json({ error: 'pdf_failed', message: e?.message || String(e) });
  } finally {
    client.release();
  }
});

// ------------------------------- 404 -----------------------------------
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ------------------------------ Start ----------------------------------
const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log(`Billing API listening on :${port}`));
