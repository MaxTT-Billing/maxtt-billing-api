// server.js — MaxTT Billing API (ESM)
// Adds robust auto-fill for: franchisee_code, invoice_seq (monthly per franchisee), invoice_number, invoice_number_norm, hsn_code.
// Safe if columns are missing (skips gracefully). No migration runner included.

import express from 'express'
import pkg from 'pg'
const { Pool } = pkg

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-REF-API-KEY')
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
function cleanNumericSql(expr) {
  return `NULLIF(regexp_replace(trim(${expr}::text),'[^0-9.+-]','','g'),'')::numeric`
}
const pad = (n, w=4) => String(Math.max(0, Number(n)||0)).padStart(w, '0')

// ------------------------------- Health --------------------------------
app.get('/', (_req, res) => res.send('MaxTT Billing API is running'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// --------------- Admin helper: create adaptive export VIEW -------------
app.get('/api/admin/create-view-auto', async (_req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const expr = (alias, cands) => {
      const f = findCol(cols, cands)
      return f ? `i.${qid(f)}::text AS ${qid(alias)}` : `NULL::text AS ${qid(alias)}`
    }
    const selectParts = [
      expr('invoice_id', ['id','invoice_id']),
      expr('invoice_number', ['invoice_number','invoice_no','inv_no','bill_no','invoice']),
      expr('invoice_ts_ist', ['invoice_ts_ist','created_at','invoice_date','date','createdon','created_on']),
      expr('franchisee_code', ['franchisee_code','franchisee','franchise_code','franchisee_id']),
      expr('admin_code', ['admin_code','admin']),
      expr('super_admin_code', ['super_admin_code','superadmin_code','sa_code']),
      expr('customer_code', ['customer_code','customer_id','customer','cust_code']),
      expr('referral_code', ['referral_code','ref_code','referral']),
      expr('vehicle_no', ['vehicle_no','vehicle_number','registration_no','reg_no','vehicle']),
      expr('vehicle_make_model', ['vehicle_make_model','make_model','model','make']),
      expr('odometer_reading', ['odometer_reading','odometer','odo','kms']),
      expr('tyre_size_fl', ['tyre_size_fl','fl_tyre','tyre_fl']),
      expr('tyre_size_fr', ['tyre_size_fr','fr_tyre','tyre_fr']),
      expr('tyre_size_rl', ['tyre_size_rl','rl_tyre','tyre_rl']),
      expr('tyre_size_rr', ['tyre_size_rr','rr_tyre','tyre_rr']),
      expr('total_qty_ml', ['total_qty_ml','dosage_ml','qty_ml','total_ml','quantity_ml','qty']),
      expr('mrp_per_ml', ['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']),
      expr('installation_cost', ['installation_cost','install_cost','labour','labour_cost']),
      expr('discount_amount', ['discount_amount','discount','disc']),
      expr('subtotal_ex_gst', ['subtotal_ex_gst','total_before_gst','subtotal','amount_before_tax']),
      expr('gst_rate', ['gst_rate','tax_rate','gst_percent','gst']),
      expr('gst_amount', ['gst_amount','tax_amount','gst_value']),
      expr('total_amount', ['total_with_gst','total_amount','grand_total','total']),
      expr('stock_level_at_start_l', ['stock_level_at_start_l','stock_before','stock_at_start_l','stock_start_liters']),
      expr('gps_lat', ['gps_lat','latitude','lat']),
      expr('gps_lng', ['gps_lng','longitude','lng','lon']),
      expr('site_address_text', ['site_address_text','address','site_address','location','customer_address']),
      expr('tread_depth_min_mm', ['tread_depth_min_mm','tread_depth','min_tread_mm','tread_depth_mm']),
      expr('speed_rating', ['speed_rating','speedrate','speed']),
      expr('created_by_user_id', ['created_by_user_id','created_by','user_id']),
      'NULL::text AS "role"'
    ]
    await client.query(`
      CREATE OR REPLACE VIEW public.v_invoice_export AS
      SELECT
        ${selectParts.join(',\n        ')}
      FROM public.invoices i;
    `)
    res.json({ ok: true, created: 'public.v_invoice_export', note: 'adaptive' })
  } catch (err) {
    res.status(500).json({ ok:false, where:'create_view_auto', message: err?.message || String(err) })
  } finally { client.release() }
})

// ------------------------------ CSV export -----------------------------
const CSV_HEADERS = [
  'Invoice ID','Invoice No','Timestamp (IST)','Franchisee Code','Admin Code','SuperAdmin Code',
  'Customer Code','Referral Code','Vehicle No','Make/Model','Odometer',
  'Tyre Size FL','Tyre Size FR','Tyre Size RL','Tyre Size RR',
  'Qty (ml)','MRP (₹/ml)','Installation Cost ₹','Discount ₹','Subtotal (ex-GST) ₹',
  'GST Rate','GST Amount ₹','Total Amount ₹',
  'Stock@Start (L)','GPS Lat','GPS Lng','Site Address','Min Tread Depth (mm)','Speed Rating',
  'Created By UserId','Created By Role'
]
const csvField = v => v==null ? '' : (/["\n,\r,;]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v))
function rowsToCsv(rows) {
  const lines = [CSV_HEADERS.map(csvField).join(',')]
  for (const r of rows) {
    lines.push([
      r.invoice_id, r.invoice_number, r.invoice_ts_ist,
      r.franchisee_code, r.admin_code, r.super_admin_code,
      r.customer_code, r.referral_code, r.vehicle_no, r.vehicle_make_model, r.odometer_reading,
      r.tyre_size_fl, r.tyre_size_fr, r.tyre_size_rl, r.tyre_size_rr,
      r.total_qty_ml, r.mrp_per_ml, r.installation_cost, r.discount_amount, r.subtotal_ex_gst,
      r.gst_rate, r.gst_amount, r.total_amount,
      r.stock_level_at_start_l, r.gps_lat, r.gps_lng, r.site_address_text,
      r.tread_depth_min_mm, r.speed_rating, r.created_by_user_id, r.role
    ].map(csvField).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

app.get('/api/exports/invoices', async (req, res) => {
  try {
    const { from, to, franchisee, q } = req.query
    const where = []; const params = []; let i = 1
    const fromSql = `public.v_invoice_export`
    if (from) { where.push(`invoice_ts_ist::date >= $${i++}`); params.push(from) }
    if (to)   { where.push(`invoice_ts_ist::date <= $${i++}`); params.push(to) }
    if (franchisee) { where.push(`franchisee_code = $${i++}`); params.push(franchisee) }
    if (q) {
      const like = `%${String(q).split('%').join('')}%`
      where.push(`(vehicle_no ILIKE $${i} OR customer_code ILIKE $${i})`); params.push(like); i++
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sql = `SELECT * FROM ${fromSql} ${whereSql} ORDER BY invoice_ts_ist DESC LIMIT 50000;`

    const client = await pool.connect()
    try {
      const result = await client.query(sql, params)
      const csv = rowsToCsv(result.rows)
      const bom = '\uFEFF'
      const now = new Date().toISOString().slice(0,19).replace(/[:T]/g,'')
      const wm = franchisee ? `_${franchisee}` : ''
      const filename = `maxtt_invoices_${now}${wm}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).send(bom + csv)
    } finally { client.release() }
  } catch (err) {
    res.status(500).json({ ok:false, error:'CSV export failed', message: err?.message || String(err) })
  }
})

// ------------------------------ Auth (demo) ----------------------------
app.post('/api/login', (_req, res) => res.json({ token: 'token-franchisee' }))
app.post('/api/admin/login', (_req, res) => res.json({ token: 'token-admin' }))
app.post('/api/sa/login',    (_req, res) => res.json({ token: 'token-sa' }))

app.get('/api/profile', (_req, res) => {
  res.json({
    name: 'Franchisee',
    franchisee_id: 'TS-DL-DEL-001',
    gstin: '',
    address: 'Address not set'
  })
})

// ---------------------- Helpers: date & numbering ----------------------
function istMonthBoundsUTC(d = new Date()) {
  // Compute month start/end in IST, then convert to UTC timestamps for SQL filtering
  const istOffsetMin = 330
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()))
  const utcMs = utc.getTime()
  const istMs = utcMs + istOffsetMin*60*1000
  const ist = new Date(istMs)
  const startIST = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0)) // IST month start at 00:00
  const endIST = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth()+1, 1, 0, 0))  // next month 00:00
  // convert back to UTC by subtracting offset
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

  // Prefer reading last seq from the printed invoice number (FRID/####/MMYY)
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

  // Fallback: use invoice_seq within current IST month based on created_at
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

  // Customer code overall seq for this franchisee (unchanged logic)
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

// ------------------------ CREATE (authoritative) -----------------------
app.post('/api/invoices/full', async (req, res) => {
  const client = await pool.connect()
  try {
    const payload = req.body || {}
    const cols = await getInvoiceCols(client)

    // Column discovery / mapping
    const qtyCols = ['total_qty_ml','dosage_ml','qty_ml','total_ml','quantity_ml','qty']
    const qtyColInTable = findCol(cols, qtyCols)

    const unitPriceCol = findCol(cols,['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']) || (has(cols,'mrp_per_ml') ? 'mrp_per_ml' : null)
    const beforeCol = findCol(cols,['total_before_gst','subtotal_ex_gst','subtotal','amount_before_tax'])
    const totalCol = findCol(cols,['total_with_gst','total_amount','grand_total','total'])
    const gstCol = findCol(cols,['gst_amount','tax_amount','gst_value'])
    const gstRateCol = findCol(cols,['gst_rate','tax_rate','gst_percent','gst'])

    const franchiseeIdCol = findCol(cols,['franchisee_id'])
    const franchiseeCodeCol = findCol(cols,['franchisee_code','franchise_code'])
    const invNoCol = findCol(cols, ['invoice_number','invoice_no','inv_no','bill_no','invoice'])
    const custCodeCol = findCol(cols, ['customer_code','customer_id','customer','cust_code'])

    const frId = String(payload[franchiseeIdCol || 'franchisee_id'] || payload.franchisee_id || '').trim() || 'TS-DL-DEL-001'

    // Compute numbering (monthly per franchisee)
    const { invoiceMonthlySeq, customerSeq, mmyy } = await computeNextNumbers(client, cols, frId)
    const printedInvoiceNo = invNoCol ? `${frId}/${pad(invoiceMonthlySeq)}/${mmyy}` : null
    const printedCustomerCode = custCodeCol ? `${frId}-${pad(customerSeq)}` : null
    const normNo = `${frId}-${pad(invoiceMonthlySeq)}`

    // ----- DOSAGE: tyre → explicit qty → money → DEFAULTS -----
    let computedQty = computeTyreDosageMl(payload)
    if (computedQty == null) {
      for (const k of qtyCols) if (payload[k] != null) { const v = asNum(payload[k]); if (v != null) { computedQty = v; break } }
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

    // Build insert payload
    const accepted = [
      franchiseeIdCol || 'franchisee_id',
      'franchisee_code', // will set if exists
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

    // Ensure IDs/codes present
    if (franchiseeIdCol && !insertPayload[franchiseeIdCol]) insertPayload[franchiseeIdCol] = frId
    if (has(cols,'franchisee_code') && !insertPayload['franchisee_code']) insertPayload['franchisee_code'] = frId

    // Generated numbers (only if columns exist)
    if (invNoCol && printedInvoiceNo) insertPayload[invNoCol] = printedInvoiceNo
    if (has(cols,'invoice_seq') && insertPayload['invoice_seq'] == null) insertPayload['invoice_seq'] = invoiceMonthlySeq
    if (has(cols,'invoice_number_norm') && !insertPayload['invoice_number_norm']) insertPayload['invoice_number_norm'] = normNo
    if (custCodeCol && printedCustomerCode && !insertPayload[custCodeCol]) insertPayload[custCodeCol] = printedCustomerCode

    // Save qty under first available qty column
    const qtyToSave = computedQty
    if (qtyToSave != null && qtyColInTable) insertPayload[qtyColInTable] = qtyToSave

    // Save computed money fields into whichever columns exist
    const setIf = (col, val) => { if (col && val != null && has(cols, col) && insertPayload[col] == null) insertPayload[col] = Number(val) }
    setIf(beforeCol, exBefore)
    setIf(totalCol, totalWithGst)
    setIf(gstCol, gstAmount)
    setIf(gstRateCol, gstRate)
    if (!beforeCol) for (const k of ['subtotal_ex_gst','total_before_gst','subtotal','amount_before_tax']) if (has(cols,k) && insertPayload[k]==null) insertPayload[k]=Number(exBefore)
    if (!totalCol)  for (const k of ['total_with_gst','total_amount','grand_total','total']) if (has(cols,k) && insertPayload[k]==null) insertPayload[k]=Number(totalWithGst)
    if (!gstCol)    for (const k of ['gst_amount','tax_amount','gst_value']) if (has(cols,k) && insertPayload[k]==null) insertPayload[k]=Number(gstAmount)
    if (!gstRateCol)for (const k of ['gst_rate','tax_rate','gst_percent','gst']) if (has(cols,k) && insertPayload[k]==null) insertPayload[k]=Number(gstRate)

    // Default HSN
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

// --------------------- Referrals test passthrough ----------------------
app.post('/__wire/referrals/test', async (req, res) => {
  try {
    const key = req.get('X-REF-API-KEY') || process.env.REF_API_WRITER_KEY
    const body = req.body || {}
    const required = ['referrer_customer_code','referred_invoice_code','franchisee_code','invoice_amount_inr','invoice_date']
    const miss = required.filter(k => !body[k])
    if (miss.length) return res.status(400).json({ ok:false, error:'missing', fields: miss })
    if (!key) return res.status(401).json({ ok:false, error:'unauthorized' })

    let postReferralFn = null
    try { const mod = await import('./referralsClient.js'); postReferralFn = mod.postReferral || mod.default } catch {}
    if (!postReferralFn) return res.status(500).json({ ok:false, error:'referrals_client_missing' })

    const r = await postReferralFn(body, key)
    return res.status(r.ok ? 200 : 502).json(r)
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) })
  }
})

// ------------------------------- 404 -----------------------------------
app.use((_req, res) => res.status(404).json({ error: 'not_found' }))

// ------------------------------ Start ----------------------------------
const port = Number(process.env.PORT || 10000)
app.listen(port, () => console.log(`Billing API listening on :${port}`))
