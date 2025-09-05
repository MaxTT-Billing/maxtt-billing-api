// server.js — MaxTT Billing API (ESM)
// Franchisee Onboarding (no DO $$ blocks). Admin endpoints gated by SUPER_ADMIN_KEY.
// Keeps invoice auto-fill, robust lookups, exports.

import express from 'express'
import pkg from 'pg'
const { Pool } = pkg

import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

// ------------------------------- CORS ---------------------------------
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://maxtt-billing-tools.onrender.com')
  .split(',').map(s => s.trim()).filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin || ''
  if (ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-REF-API-KEY, X-SA-KEY')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

app.use(express.json({ limit: '15mb' }))

// ------------------------------- DB -----------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// --------------------------- Column helpers ---------------------------
let cachedCols = null
async function getInvoiceCols(client) {
  if (cachedCols) return cachedCols
  const r = await client.query(`
    SELECT lower(column_name) AS name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices'
  `)
  cachedCols = new Set(r.rows.map(x => x.name))
  return cachedCols
}
const has = (cols, n) => cols.has(String(n).toLowerCase())
const qid = (n) => `"${n}"`
function findCol(cols, candidates) { for (const c of candidates) if (has(cols, c)) return c; return null }
const pad = (n, w=4) => String(Math.max(0, Number(n)||0)).padStart(w, '0')

// ------------------------------- Health --------------------------------
app.get('/', (_req, res) => res.send('MaxTT Billing API is running'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// ------------------------------- Auth ----------------------------------
function requireSA(req, res, next) {
  const key = req.get('X-SA-KEY') || ''
  const expect = process.env.SUPER_ADMIN_KEY || ''
  if (!expect) return res.status(500).json({ ok:false, error:'super_admin_key_not_set' })
  if (key !== expect) return res.status(401).json({ ok:false, error:'unauthorized' })
  next()
}

// ------------------- Admin installer for franchisees table -------------
app.post('/api/admin/franchisees/install', requireSA, async (_req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1) Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.franchisees (
        id BIGSERIAL PRIMARY KEY,
        franchisee_id TEXT UNIQUE NOT NULL,
        legal_name TEXT NOT NULL,
        gstin TEXT,
        pan TEXT,
        state TEXT,
        state_code TEXT NOT NULL,
        city TEXT,
        city_code TEXT NOT NULL,
        pincode TEXT,
        address1 TEXT,
        address2 TEXT,
        phone TEXT,
        email TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        api_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    // 2) Indexes (idempotent)
    await client.query(`CREATE INDEX IF NOT EXISTS ix_franchisees_state_city ON public.franchisees (state_code, city_code);`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_franchisees_gstin_lower ON public.franchisees ((lower(gstin))) WHERE gstin IS NOT NULL;`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_franchisees_email_lower ON public.franchisees ((lower(email))) WHERE email IS NOT NULL;`)

    // 3) updated_at function (idempotent)
    await client.query(`
      CREATE OR REPLACE FUNCTION franchisees_set_updated_at() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at := NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)

    // 4) Trigger: drop-if-exists then create (idempotent)
    await client.query(`DROP TRIGGER IF EXISTS trg_franchisees_updated_at ON public.franchisees;`)
    await client.query(`
      CREATE TRIGGER trg_franchisees_updated_at
      BEFORE UPDATE ON public.franchisees
      FOR EACH ROW EXECUTE FUNCTION franchisees_set_updated_at();
    `)

    await client.query('COMMIT')
    res.json({ ok:true, installed:true })
  } catch (e) {
    try { await pool.query('ROLLBACK') } catch {}
    res.status(500).json({ ok:false, error:String(e?.message || e) })
  } finally { client.release() }
})

// ---------------------- Helpers: date & numbering ----------------------
function istMonthBoundsUTC(d = new Date()) {
  const istOffsetMin = 330
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()))
  const utcMs = utc.getTime()
  const istMs = utcMs + istOffsetMin*60*1000
  const ist = new Date(istMs)
  const startIST = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0))
  const endIST = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth()+1, 1, 0, 0))
  const startUTC = new Date(startIST.getTime() - istOffsetMin*60*1000)
  const endUTC = new Date(endIST.getTime() - istOffsetMin*60*1000)
  return { startUTC, endUTC }
}

async function computeNextNumbers(client, cols, franchiseeId) {
  const invNoCol = findCol(cols, ['invoice_number','invoice_no','inv_no','bill_no','invoice'])
  const custCodeCol = findCol(cols, ['customer_code','customer_id','customer','cust_code'])
  const dateCol = findCol(cols,['invoice_ts_ist','created_at','invoice_date','date','createdon','created_on']) || 'created_at'
  const franchiseeCodeCol = findCol(cols,['franchisee_code','franchise_code'])

  const today = new Date()
  const mm = String(today.getUTCMonth()+1).padStart(2,'0')
  const yy = String(today.getUTCFullYear()).slice(-2)
  const mmyy = `${mm}${yy}`

  let nextMonthly = 1
  if (invNoCol) {
    const sql = `
      SELECT ${qid(invNoCol)} AS inv
      FROM public.invoices
      WHERE ${qid(invNoCol)} ILIKE $1
      ORDER BY 1 DESC
      LIMIT 300
    `
    const likePrefix = `${franchiseeId}/%/${mmyy}%`
    const r = await client.query(sql, [likePrefix])
    for (const row of r.rows) {
      const s = String(row.inv || '')
      const m = s.match(/^[A-Z-0-9-]+\/(\d{4})\/(\d{4})$/i)
      if (m) {
        const seq = Number(m[1]||'0')
        if (Number.isFinite(seq) && seq >= nextMonthly) nextMonthly = seq + 1
      }
    }
  }

  if (nextMonthly === 1 && has(cols,'invoice_seq')) {
    const { startUTC, endUTC } = istMonthBoundsUTC(today)
    const sql = `
      SELECT COALESCE(MAX(invoice_seq), 0) AS maxseq
      FROM public.invoices
      WHERE COALESCE(${franchiseeCodeCol ? qid(franchiseeCodeCol) : `'${franchiseeId}'`}, '${franchiseeId}') = $1
        AND ${qid(dateCol)} >= $2 AND ${qid(dateCol)} < $3
    `
    const r = await client.query(sql, [franchiseeId, startUTC.toISOString(), endUTC.toISOString()])
    nextMonthly = Number(r.rows?.[0]?.maxseq || 0) + 1
  }

  let nextCust = 1
  if (custCodeCol) {
    const sql = `
      SELECT ${qid(custCodeCol)} AS cc
      FROM public.invoices
      WHERE ${qid(custCodeCol)} ILIKE $1
      ORDER BY 1 DESC
      LIMIT 200
    `
    const like = `${franchiseeId}-%`
    const r = await client.query(sql, [like])
    for (const row of r.rows) {
      const s = String(row.cc||'')
      const m = s.match(/^[A-Z-0-9-]+-(\d{4,})$/i)
      if (m) {
        const seq = Number(m[1]||'0')
        if (Number.isFinite(seq) && seq >= nextCust) nextCust = seq + 1
      }
    }
  }
  return { invoiceMonthlySeq: nextMonthly, customerSeq: nextCust, mmyy }
}

// ---------------------- Tyre dosage (preferred) -----------------------
function asNum(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim().replace(/[^0-9.+-]/g,'')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function inferTyreCountFromPayload(p) {
  let count = 0
  const have = (k) => p[k] != null && String(p[k]).trim() !== ''
  const slots = ['fl','fr','rl','rr']
  for (const pos of slots) {
    if (have(`tyre_size_${pos}`) || (have(`tread_${pos}_mm`) && (have('tyre_width_mm')||have('aspect_ratio')||have('rim_diameter_in')))) count++
  }
  if (count === 0) count = asNum(p['tyre_count']) || asNum(p['no_of_tyres']) || asNum(p['number_of_tyres']) || null
  return count
}

function recommendPerTyreMl(widthMm = 195, rimIn = 15) {
  const w = Number(widthMm)||195
  const r = Number(rimIn)||15
  let base = 260
  if (w <= 165) base = 220
  else if (w <= 175) base = 240
  else if (w <= 185) base = 260
  else if (w <= 195) base = 300
  else if (w <= 205) base = 320
  else if (w <= 215) base = 340
  else if (w <= 225) base = 360
  else base = 380
  if (r >= 17) base += 30
  if (r >= 18) base += 30
  if (r >= 19) base += 20
  if (r >= 20) base += 20
  base = Math.max(150, Math.min(base, 600))
  return Math.round(base/10)*10
}

function computeTyreDosageMl(payload) {
  const width = asNum(payload['tyre_width_mm'])
  const rim = asNum(payload['rim_diameter_in'])
  const count = inferTyreCountFromPayload(payload) || 4
  if (!width && !rim) return null
  const perTyre = recommendPerTyreMl(width||195, rim||15)
  return perTyre * count
}

// ------------------------ CREATE invoices (authoritative) --------------
app.post('/api/invoices/full', async (req, res) => {
  const client = await pool.connect()
  try {
    const payload = req.body || {}
    const cols = await getInvoiceCols(client)

    const qtyCols = ['total_qty_ml','dosage_ml','qty_ml','total_ml','quantity_ml','qty']
    const qtyColInTable = findCol(cols, qtyCols)

    const unitPriceCol = findCol(cols,['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']) || (has(cols,'mrp_per_ml') ? 'mrp_per_ml' : null)
    const beforeCol = findCol(cols,['total_before_gst','subtotal_ex_gst','subtotal','amount_before_tax'])
    const totalCol = findCol(cols,['total_with_gst','total_amount','grand_total','total'])
    const gstCol = findCol(cols,['gst_amount','tax_amount','gst_value'])
    const gstRateCol = findCol(cols,['gst_rate','tax_rate','gst_percent','gst'])

    const franchiseeIdCol = findCol(cols,['franchisee_id'])
    const invNoCol = findCol(cols, ['invoice_number','invoice_no','inv_no','bill_no','invoice'])
    const custCodeCol = findCol(cols, ['customer_code','customer_id','customer','cust_code'])

    const frId = String(payload[franchiseeIdCol || 'franchisee_id'] || payload.franchisee_id || '').trim() || 'TS-DL-DEL-001'

    const { invoiceMonthlySeq, customerSeq, mmyy } = await computeNextNumbers(client, cols, frId)
    const printedInvoiceNo = invNoCol ? `${frId}/${pad(invoiceMonthlySeq)}/${mmyy}` : null
    const printedCustomerCode = custCodeCol ? `${frId}-${pad(customerSeq)}` : null
    const normNo = `${frId}-${pad(invoiceMonthlySeq)}`

    let computedQty = computeTyreDosageMl(payload)
    if (computedQty == null) {
      for (const k of qtyCols) {
        if (payload[k] != null) {
          const v = asNum(payload[k])
          if (v != null) { computedQty = v; break }
        }
      }
    }

    const envDefaultQty = Number(process.env.DEFAULT_QTY_ML || 1200)
    const fallbackUnit = Number(process.env.FALLBACK_MRP_PER_ML || 4.5)

    const unitPrice =
      (unitPriceCol ? (asNum(payload[unitPriceCol]) ?? asNum(payload.mrp_per_ml) ?? asNum(payload.price_per_ml)) : (asNum(payload.mrp_per_ml) ?? asNum(payload.price_per_ml)))
      ?? fallbackUnit

    let exBefore =
      (beforeCol ? (asNum(payload[beforeCol]) ?? asNum(payload.total_before_gst) ?? asNum(payload.subtotal_ex_gst) ?? asNum(payload.subtotal) ?? asNum(payload.amount_before_tax))
                 : (asNum(payload.total_before_gst) ?? asNum(payload.subtotal_ex_gst) ?? asNum(payload.subtotal) ?? asNum(payload.amount_before_tax)))

    if (computedQty == null && exBefore != null && unitPrice) computedQty = exBefore / unitPrice
    if (computedQty == null) computedQty = envDefaultQty
    if (exBefore == null) exBefore = computedQty * unitPrice

    let gstRate = asNum(payload[gstRateCol || 'gst_rate']); if (gstRate == null) gstRate = 18
    let gstAmount = (asNum(payload[gstCol]) ?? asNum(payload.gst_amount) ?? asNum(payload.tax_amount) ?? asNum(payload.gst_value))
    if (gstAmount == null) gstAmount = (Number(exBefore) * Number(gstRate)) / 100
    let totalWithGst = (asNum(payload[totalCol]) ?? asNum(payload.total_with_gst) ?? asNum(payload.total_amount) ?? asNum(payload.grand_total) ?? asNum(payload.total))
    if (totalWithGst == null) totalWithGst = Number(exBefore) + Number(gstAmount)

    const accepted = [
      franchiseeIdCol || 'franchisee_id',
      'franchisee_code',
      invNoCol || 'invoice_number',
      'invoice_seq',
      'invoice_number_norm',
      custCodeCol || 'customer_code',

      'customer_name','customer_gstin','customer_address','vehicle_number','vehicle_no','vehicle','vehicle_type',
      'tyre_count','fitment_locations','installer_name',
      ...qtyCols,
      'mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml',
      'installation_cost','install_cost','labour','labour_cost',
      'discount_amount','discount','disc',
      'subtotal_ex_gst','total_before_gst','gst_rate','gst_amount','total_with_gst','total_amount','grand_total','total',
      'tyre_width_mm','aspect_ratio','rim_diameter_in','tread_depth_min_mm','speed_rating',
      'tread_fl_mm','tread_fr_mm','tread_rl_mm','tread_rr_mm',
      'stock_level_at_start_l','site_address_text','hsn_code',
      'referral_code','customer_signature','signed_at','consent_signature','consent_signed_at','gps_lat','gps_lng',
    ]
    const insertPayload = {}
    for (const key of accepted) {
      if (!key) continue
      if (has(cols, key) && payload[key] !== undefined) insertPayload[key] = payload[key]
    }

    if (has(cols,'franchisee_code') && !insertPayload['franchisee_code']) insertPayload['franchisee_code'] = frId

    if (invNoCol && printedInvoiceNo) insertPayload[invNoCol] = printedInvoiceNo
    if (has(cols,'invoice_seq') && insertPayload['invoice_seq'] == null) insertPayload['invoice_seq'] = invoiceMonthlySeq
    if (has(cols,'invoice_number_norm') && !insertPayload['invoice_number_norm']) insertPayload['invoice_number_norm'] = normNo
    if (custCodeCol && printedCustomerCode && !insertPayload[custCodeCol]) insertPayload[custCodeCol] = printedCustomerCode

    const qtyToSave = computedQty
    if (qtyToSave != null && qtyColInTable) insertPayload[qtyColInTable] = qtyToSave

    const setIf = (col, val) => { if (col && val != null && has(cols, col) && insertPayload[col] == null) insertPayload[col] = Number(val) }
    setIf(beforeCol, exBefore)
    setIf(totalCol, totalWithGst)
    setIf(gstCol, gstAmount)
    setIf(gstRateCol, gstRate)

    if (!beforeCol) {
      for (const k of ['subtotal_ex_gst','total_before_gst','subtotal','amount_before_tax']) {
        if (has(cols,k) && insertPayload[k] == null) insertPayload[k] = Number(exBefore)
      }
    }
    if (!totalCol) {
      for (const k of ['total_with_gst','total_amount','grand_total','total']) {
        if (has(cols,k) && insertPayload[k] == null) insertPayload[k] = Number(totalWithGst)
      }
    }
    if (!gstCol) {
      for (const k of ['gst_amount','tax_amount','gst_value']) {
        if (has(cols,k) && insertPayload[k] == null) insertPayload[k] = Number(gstAmount)
      }
    }
    if (!gstRateCol) {
      for (const k of ['gst_rate','tax_rate','gst_percent','gst']) {
        if (has(cols,k) && insertPayload[k] == null) insertPayload[k] = Number(gstRate)
      }
    }

    if (has(cols,'hsn_code') && insertPayload['hsn_code'] == null) insertPayload['hsn_code'] = '35069999'
    if (unitPriceCol && insertPayload[unitPriceCol] == null) insertPayload[unitPriceCol] = Number(unitPrice)

    const keys = Object.keys(insertPayload)
    if (!keys.length) return res.status(400).json({ ok:false, error:'no_matching_columns' })

    const sql = `INSERT INTO public.invoices (${keys.map(qid).join(', ')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(', ')}) RETURNING *`
    const r = await client.query(sql, keys.map(k => insertPayload[k]))
    const row = r.rows[0]

    res.status(201).json({
      ok: true,
      id: row?.id ?? row?.invoice_id ?? null,
      invoice_number: row?.[invNoCol || 'invoice_number'] ?? null,
      invoice_number_norm: row?.invoice_number_norm ?? null,
      customer_code: row?.[custCodeCol || 'customer_code'] ?? null,
      qty_ml_saved: qtyToSave ?? null
    })
  } catch (err) {
    res.status(400).json({ ok:false, error: err?.message || String(err) })
  } finally { client.release() }
})

// ---------------------- READ: list, latest, get, by-norm ---------------
function sel(cols, alias, candidates, type='text') {
  const f = findCol(cols, candidates)
  return f ? `i.${qid(f)}::${type} AS ${qid(alias)}`
           : `NULL::${type} AS ${qid(alias)}`
}

app.get('/api/invoices', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const selects = [
      sel(cols, 'id', ['id','invoice_id']),
      sel(cols, 'created_at', ['invoice_ts_ist','created_at','invoice_date','date','createdon','created_on']),
      sel(cols, 'customer_name', ['customer_name','customer']),
      sel(cols, 'vehicle_number', ['vehicle_number','vehicle_no','registration_no','reg_no']),
      sel(cols, 'vehicle_type', ['vehicle_type','category']),
      sel(cols, 'tyre_count', ['tyre_count','no_of_tyres','number_of_tyres']),
      sel(cols, 'fitment_locations', ['fitment_locations','fitment','fitment_location']),
      sel(cols, 'dosage_ml', ['total_qty_ml','dosage_ml','qty_ml','total_ml','quantity_ml','qty']),
      sel(cols, 'total_with_gst', ['total_with_gst','total_amount','grand_total','total']),
      sel(cols, 'total_before_gst', ['total_before_gst','subtotal_ex_gst','subtotal','amount_before_tax']),
      sel(cols, 'gst_amount', ['gst_amount','tax_amount','gst_value']),
      sel(cols, 'price_per_ml', ['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']),
      sel(cols, 'tyre_width_mm', ['tyre_width_mm','tyre_width']),
      sel(cols, 'aspect_ratio', ['aspect_ratio']),
      sel(cols, 'rim_diameter_in', ['rim_diameter_in','rim_diameter']),
      sel(cols, 'tread_depth_mm', ['tread_depth_mm','tread_depth']),
      sel(cols, 'installer_name', ['installer_name'])
    ]
    const where = []; const params = []; let i = 1
    if (req.query.q) {
      const like = `%${String(req.query.q).split('%').join('')}%`
      const vcol = findCol(cols,['vehicle_number','vehicle_no','registration_no','reg_no'])
      const ccol = findCol(cols,['customer_name','customer'])
      const or = []
      if (vcol) or.push(`i.${qid(vcol)} ILIKE $${i}`)
      if (ccol) or.push(`i.${qid(ccol)} ILIKE $${i}`)
      if (or.length) { where.push(`(${or.join(' OR ')})`); params.push(like); i++ }
    }
    const dcol = findCol(cols,['invoice_ts_ist','created_at','invoice_date','date','createdon','created_on']) || 'created_at'
    const sql = `
      SELECT ${selects.join(', ')}
      FROM public.invoices i
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY i.${qid(dcol)} DESC
      LIMIT ${Math.min(Number(req.query.limit || 500), 5000)}
    `
    const r = await client.query(sql, params)
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ ok:false, where:'list_invoices', message: err?.message || String(err) })
  } finally { client.release() }
})

app.get('/api/invoices/latest', async (_req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const idCol = findCol(cols,['id','invoice_id']) || 'id'
    const r = await client.query(`SELECT ${qid(idCol)} AS id FROM public.invoices ORDER BY ${qid(idCol)} DESC LIMIT 1`)
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'empty' })
    res.json({ id: r.rows[0].id })
  } catch (err) {
    res.status(500).json({ ok:false, where:'latest', message: err?.message || String(err) })
  } finally { client.release() }
})

app.get(['/api/invoices/:id/full2', '/invoices/:id/full2'], async (req, res) => {
  const client = await pool.connect()
  try {
    const id = Number(req.params.id || 0)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok:false, error:'bad_id' })
    const cols = await getInvoiceCols(client)
    const idCol = findCol(cols,['id','invoice_id']) || 'id'
    const r = await client.query(`SELECT * FROM public.invoices WHERE ${qid(idCol)}=$1 LIMIT 1`, [id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.setHeader('Cache-Control','no-store')
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'get_invoice_full2', message: err?.message || String(err) })
  } finally { client.release() }
})

app.get('/api/invoices/by-norm/:norm', async (req, res) => {
  const client = await pool.connect()
  try {
    const norm = String(req.params.norm || '').trim()
    if (!norm) return res.status(400).json({ ok:false, error:'missing_norm' })
    const cols = await getInvoiceCols(client)
    if (!has(cols,'invoice_number_norm')) {
      return res.status(400).json({ ok:false, error:'column_missing: invoice_number_norm' })
    }
    const r = await client.query(`SELECT * FROM public.invoices WHERE "invoice_number_norm" = $1 LIMIT 1`, [norm])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'by_norm', message: err?.message || err })
  } finally { client.release() }
})

// ---------------------- Franchisee Onboarding APIs ---------------------
function makeFrId(stateCode, cityCode, n) {
  const sc = String(stateCode||'').toUpperCase().replace(/[^A-Z]/g,'')
  const cc = String(cityCode||'').toUpperCase().replace(/[^A-Z]/g,'')
  return `TS-${sc}-${cc}-${String(n).padStart(3,'0')}`
}

async function nextFrSuffix(client, stateCode, cityCode) {
  const like = `TS-${String(stateCode).toUpperCase()}-${String(cityCode).toUpperCase()}-%`
  const r = await client.query(
    `SELECT franchisee_id FROM public.franchisees WHERE franchisee_id ILIKE $1 ORDER BY franchisee_id DESC LIMIT 200`,
    [like]
  )
  let maxN = 0
  for (const row of r.rows) {
    const m = String(row.franchisee_id || '').match(/^TS-[A-Z]+-[A-Z]+-(\d{3,})$/)
    if (m) {
      const n = Number(m[1]); if (Number.isFinite(n) && n > maxN) maxN = n
    }
  }
  return maxN + 1
}

app.post('/api/admin/franchisees/onboard', requireSA, async (req, res) => {
  const client = await pool.connect()
  try {
    const b = req.body || {}
    const required = ['legal_name','state_code','city_code']
    const miss = required.filter(k => !b[k] || String(b[k]).trim()==='')
    if (miss.length) return res.status(400).json({ ok:false, error:'missing_fields', fields: miss })

    const sc = String(b.state_code).toUpperCase().trim()
    const cc = String(b.city_code).toUpperCase().trim()

    let franchiseeId = null
    if (b.franchisee_id_override) {
      franchiseeId = String(b.franchisee_id_override).toUpperCase().trim()
      if (!/^TS-[A-Z]+-[A-Z]+-\d{3,}$/.test(franchiseeId)) {
        return res.status(400).json({ ok:false, error:'override_pattern_invalid' })
      }
      const u = await client.query(`SELECT 1 FROM public.franchisees WHERE franchisee_id=$1 LIMIT 1`, [franchiseeId])
      if (u.rows.length) return res.status(409).json({ ok:false, error:'franchisee_id_exists' })
    } else {
      const n = await nextFrSuffix(client, sc, cc)
      franchiseeId = makeFrId(sc, cc, n)
    }

    const sql = `
      INSERT INTO public.franchisees (
        franchisee_id, legal_name, gstin, pan, state, state_code, city, city_code,
        pincode, address1, address2, phone, email, status, api_key
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,COALESCE($14,'ACTIVE'),$15
      ) RETURNING *
    `
    const params = [
      franchiseeId,
      b.legal_name || null,
      b.gstin || null,
      b.pan || null,
      b.state || null,
      sc,
      b.city || null,
      cc,
      b.pincode || null,
      b.address1 || null,
      b.address2 || null,
      b.phone || null,
      b.email || null,
      b.status || null,
      b.api_key || null
    ]
    const r = await client.query(sql, params)
    res.status(201).json({ ok:true, franchisee: r.rows[0] })
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) })
  } finally { client.release() }
})

app.get('/api/admin/franchisees', requireSA, async (_req, res) => {
  const client = await pool.connect()
  try {
    const r = await client.query(`SELECT * FROM public.franchisees ORDER BY created_at DESC LIMIT 500`)
    res.json({ ok:true, items: r.rows })
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) })
  } finally { client.release() }
})

app.get('/api/admin/franchisees/:id_or_code', requireSA, async (req, res) => {
  const client = await pool.connect()
  try {
    const v = String(req.params.id_or_code || '').trim()
    let r
    if (/^\d+$/.test(v)) {
      r = await client.query(`SELECT * FROM public.franchisees WHERE id=$1 LIMIT 1`, [Number(v)])
    } else {
      r = await client.query(`SELECT * FROM public.franchisees WHERE franchisee_id=$1 LIMIT 1`, [v.toUpperCase()])
    }
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json({ ok:true, franchisee: r.rows[0] })
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) })
  } finally { client.release() }
})

// ------------------------------- 404 -----------------------------------
app.use((_req, res) => res.status(404).json({ error: 'not_found' }))

// ------------------------------ Start ----------------------------------
const port = Number(process.env.PORT || 10000)
app.listen(port, () => console.log(`Billing API listening on :${port}`))
