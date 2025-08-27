// server.js — Billing API (ESM) with adaptive columns + CSV export
// + Wire-up to Seal & Earn using normalized FRAN-#### codes
// + FULL invoice endpoint (/api/invoices/:id/full) returning ALL columns
//
// Requires: referralsHook.js, referralsClient.js at repo root

import express from 'express'
import cors from 'cors'
import pkg from 'pg'
const { Pool } = pkg

// === Wire to Seal & Earn ===
import { sendForInvoice } from './referralsHook.js'
import { postReferral } from './referralsClient.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// --- DB connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// ------------ Helpers ------------
let cachedCols = null
async function getInvoiceCols(client) {
  if (cachedCols) return cachedCols
  const q = `
    SELECT lower(column_name) AS name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices'
  `
  const r = await client.query(q)
  cachedCols = new Set(r.rows.map(x => x.name))
  return cachedCols
}
function has(cols, name) { return cols.has(String(name).toLowerCase()) }
function qid(name) { return `"${name}"` }
function sel(cols, alias, candidates, type = 'text') {
  const found = candidates.find(c => has(cols, c))
  return found ? `i.${qid(found)}::${type} AS ${qid(alias)}`
               : `NULL::${type} AS ${qid(alias)}`
}

// ------------ Basic + diagnostics ------------
app.get('/', (_req, res) => res.send('MaxTT Billing API is running'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.get('/api/diag/whoami', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT current_database() AS db, current_schema() AS schema`)
    const url = process.env.DATABASE_URL || ''
    let host = '', databaseFromUrl = ''
    try { const u = new URL(url); host = u.hostname; databaseFromUrl = (u.pathname||'').replace('/','') } catch {}
    res.json({ ok: true, current_database: r.rows[0]?.db, current_schema: r.rows[0]?.schema, url_host: host, url_database: databaseFromUrl, ssl: true })
  } catch (err) {
    res.status(500).json({ ok:false, where:'whoami', message: err?.message || String(err) })
  }
})

app.get('/api/diag/view', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT to_regclass('public.v_invoice_export') AS v`)
    const exists = r.rows[0]?.v
    if (!exists) return res.json({ ok:false, where:'view_check', reason:'view_missing' })
    res.json({ ok:true, view: String(exists) })
  } catch (err) {
    res.status(500).json({ ok:false, where:'view_check', message: err?.message || String(err) })
  }
})

// ------------ Admin helper: auto-create CSV view ------------
app.get('/api/admin/create-view-auto', async (_req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const pick = (...cands) => cands.find(c => has(cols, c)) || null
    const expr = (alias, candidates) => {
      const f = pick(...candidates)
      return f ? `i.${qid(f)}::text AS ${qid(alias)}` : `NULL::text AS ${qid(alias)}`
    }

    const selectParts = [
      expr('invoice_id', ['id','invoice_id']),
      expr('invoice_number', ['invoice_number','invoice_no','inv_no','bill_no','invoice']),
      expr('invoice_ts_ist', ['invoice_ts_ist','created_at','invoice_date','createdon','created_on','date']),
      expr('franchisee_code', ['franchisee_code','franchisee','franchise_code']),
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
      expr('total_qty_ml', ['total_qty_ml','qty_ml','total_ml','quantity_ml','qty','dosage_ml']),
      expr('mrp_per_ml', ['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']),
      expr('installation_cost', ['installation_cost','install_cost','labour','labour_cost']),
      expr('discount_amount', ['discount_amount','discount','disc']),
      expr('subtotal_ex_gst', ['subtotal_ex_gst','subtotal','sub_total','amount_before_tax','amount_ex_gst','pre_tax_total','total_before_gst']),
      expr('gst_rate', ['gst_rate','tax_rate','gst_percent','gst']),
      expr('gst_amount', ['gst_amount','tax_amount','gst_value']),
      expr('total_amount', ['total_amount','grand_total','total','amount','total_with_gst']),
      expr('stock_level_at_start_l', ['stock_level_at_start_l','stock_before','stock_at_start_l','stock_start_liters']),
      expr('gps_lat', ['gps_lat','latitude','lat']),
      expr('gps_lng', ['gps_lng','longitude','lng','lon']),
      expr('site_address_text', ['site_address_text','address','site_address','location','customer_address']),
      expr('tread_depth_min_mm', ['tread_depth_min_mm','tread_depth','min_tread_mm','tread_depth_mm']),
      expr('speed_rating', ['speed_rating','speedrate','speed']),
      expr('created_by_user_id', ['created_by_user_id','created_by','user_id']),
      'NULL::text AS "role"'
    ]

    const createViewSql = `
      CREATE OR REPLACE VIEW public.v_invoice_export AS
      SELECT
        ${selectParts.join(',\n        ')}
      FROM public.invoices i;
    `
    await client.query(createViewSql)
    res.json({ ok:true, created:'public.v_invoice_export', note:'adaptive' })
  } catch (err) {
    res.status(500).json({ ok:false, where:'create_view_auto', message: err?.message || String(err) })
  } finally {
    client.release()
  }
})

// ------------ CSV helpers ------------
const CSV_HEADERS = [
  'Invoice ID','Invoice No','Timestamp (IST)','Franchisee Code','Admin Code','SuperAdmin Code',
  'Customer Code','Referral Code','Vehicle No','Make/Model','Odometer',
  'Tyre Size FL','Tyre Size FR','Tyre Size RL','Tyre Size RR',
  'Qty (ml)','MRP (/ml ₹)','Installation Cost ₹','Discount ₹','Subtotal (ex-GST) ₹',
  'GST Rate','GST Amount ₹','Total Amount ₹',
  'Stock@Start (L)','GPS Lat','GPS Lng','Site Address','Min Tread Depth (mm)','Speed Rating',
  'Created By UserId','Created By Role'
]
function csvField(val) {
  if (val === null || val === undefined) return ''
  const s = String(val)
  const mustQuote = s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r') || s.includes(';')
  const escaped = s.split('"').join('""')
  return mustQuote ? `"${escaped}"` : escaped
}
function rowsToCsv(rows) {
  const header = CSV_HEADERS.map(csvField).join(',')
  const lines = [header]
  for (const r of rows) {
    const fields = [
      r.invoice_id, r.invoice_number, r.invoice_ts_ist,
      r.franchisee_code, r.admin_code, r.super_admin_code,
      r.customer_code, r.referral_code, r.vehicle_no, r.vehicle_make_model, r.odometer_reading,
      r.tyre_size_fl, r.tyre_size_fr, r.tyre_size_rl, r.tyre_size_rr,
      r.total_qty_ml, r.mrp_per_ml, r.installation_cost, r.discount_amount, r.subtotal_ex_gst,
      r.gst_rate, r.gst_amount, r.total_amount,
      r.stock_level_at_start_l, r.gps_lat, r.gps_lng, r.site_address_text,
      r.tread_depth_min_mm, r.speed_rating, r.created_by_user_id, r.role,
    ]
    lines.push(fields.map(csvField).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

// ------------ CSV export ------------
app.get('/api/exports/invoices', async (req, res) => {
  try {
    const { from, to, franchisee, q } = req.query
    const where = []
    const params = []
    let i = 1

    // Read from the adaptive view; if missing, it'll error and be caught
    const fromSql = `public.v_invoice_export`

    if (from) { where.push(`invoice_ts_ist::date >= $${i++}`); params.push(from) }
    if (to)   { where.push(`invoice_ts_ist::date <= $${i++}`); params.push(to) }
    if (franchisee) { where.push(`franchisee_code = $${i++}`); params.push(franchisee) }
    if (q) {
      const like = `%${String(q).split('%').join('')}%`
      where.push(`(vehicle_no ILIKE $${i} OR customer_code ILIKE $${i})`)
      params.push(like); i++
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
    } finally {
      client.release()
    }
  } catch (err) {
    res.status(500).json({ ok:false, error:'CSV export failed', message: err?.message || String(err) })
  }
})

// ------------ Auth (very light, demo) ------------
app.post('/api/login', (req, res) => {
  // Accept anything; return a token so the UI can proceed.
  res.json({ token: 'token-franchisee' })
})
app.post('/api/admin/login', (req, res) => res.json({ token: 'token-admin' }))
app.post('/api/sa/login',    (req, res) => res.json({ token: 'token-sa' }))

// Profile (static demo info so UI header works)
app.get('/api/profile', (_req, res) => {
  res.json({
    name: 'Franchisee',
    franchisee_id: 'MAXTT-DEMO-001',
    gstin: '',
    address: 'Address not set'
  })
})

// ------------ Invoices: list / get / create / update / summary ------------
app.get('/api/invoices', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const selects = [
      sel(cols, 'id', ['id','invoice_id']),
      sel(cols, 'created_at', ['created_at','invoice_date','date','createdon','created_on']),
      sel(cols, 'customer_name', ['customer_name','customer']),
      sel(cols, 'vehicle_number', ['vehicle_number','vehicle_no','registration_no','reg_no']),
      sel(cols, 'vehicle_type', ['vehicle_type','category']),
      sel(cols, 'tyre_count', ['tyre_count','no_of_tyres','number_of_tyres']),
      sel(cols, 'fitment_locations', ['fitment_locations','fitment','fitment_location']),
      sel(cols, 'dosage_ml', ['dosage_ml','total_qty_ml','qty_ml','quantity_ml']),
      sel(cols, 'total_with_gst', ['total_with_gst','total_amount','grand_total','total']),
      sel(cols, 'total_before_gst', ['total_before_gst','subtotal_ex_gst','subtotal','amount_before_tax']),
      sel(cols, 'gst_amount', ['gst_amount','tax_amount','gst_value']),
      sel(cols, 'price_per_ml', ['price_per_ml','mrp_per_ml']),
      sel(cols, 'tyre_width_mm', ['tyre_width_mm','tyre_width']),
      sel(cols, 'aspect_ratio', ['aspect_ratio']),
      sel(cols, 'rim_diameter_in', ['rim_diameter_in','rim_diameter']),
      sel(cols, 'tread_depth_mm', ['tread_depth_mm','tread_depth']),
      sel(cols, 'installer_name', ['installer_name'])
    ]
    const where = []
    const params = []
    let i = 1
    // filters
    if (req.query.q) {
      const like = `%${String(req.query.q).split('%').join('')}%`
      const or = []
      if (has(cols,'vehicle_number')) or.push(`i."vehicle_number" ILIKE $${i}`)
      if (has(cols,'vehicle_no'))     or.push(`i."vehicle_no" ILIKE $${i}`)
      if (has(cols,'customer_name'))  or.push(`i."customer_name" ILIKE $${i}`)
      if (or.length) { where.push(`(${or.join(' OR ')})`); params.push(like); i++ }
    }
    if (req.query.from && has(cols,'created_at')) { where.push(`i."created_at"::date >= $${i++}`); params.push(req.query.from) }
    if (req.query.to   && has(cols,'created_at')) { where.push(`i."created_at"::date <= $${i++}`); params.push(req.query.to) }

    const limit = Math.min( Number(req.query.limit || 500), 5000 )
    const sql = `
      SELECT ${selects.join(',\n             ')}
      FROM public.invoices i
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY 1 DESC
      LIMIT ${limit}
    `
    const r = await client.query(sql, params)
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ ok:false, where:'list_invoices', message: err?.message || String(err) })
  } finally {
    client.release()
  }
})

app.get('/api/invoices/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const selects = [
      sel(cols,'id',['id','invoice_id']),
      sel(cols,'created_at',['created_at','invoice_date','date','createdon','created_on']),
      sel(cols,'customer_name',['customer_name','customer']),
      sel(cols,'mobile_number',['mobile_number','mobile','phone']),
      sel(cols,'vehicle_number',['vehicle_number','vehicle_no','registration_no','reg_no']),
      sel(cols,'vehicle_type',['vehicle_type','category']),
      sel(cols,'tyre_count',['tyre_count','no_of_tyres','number_of_tyres']),
      sel(cols,'tyre_width_mm',['tyre_width_mm','tyre_width']),
      sel(cols,'aspect_ratio',['aspect_ratio']),
      sel(cols,'rim_diameter_in',['rim_diameter_in','rim_diameter']),
      sel(cols,'tread_depth_mm',['tread_depth_mm','tread_depth']),
      sel(cols,'fitment_locations',['fitment_locations','fitment','fitment_location']),
      sel(cols,'dosage_ml',['dosage_ml','total_qty_ml','qty_ml','quantity_ml']),
      sel(cols,'price_per_ml',['price_per_ml','mrp_per_ml']),
      sel(cols,'total_before_gst',['total_before_gst','subtotal_ex_gst','subtotal','amount_before_tax']),
      sel(cols,'gst_amount',['gst_amount','tax_amount','gst_value']),
      sel(cols,'total_with_gst',['total_with_gst','total_amount','grand_total','total']),
      sel(cols,'customer_gstin',['customer_gstin','gstin']),
      sel(cols,'customer_address',['customer_address','address','site_address_text']),
      sel(cols,'installer_name',['installer_name']),
      sel(cols,'customer_signature',['customer_signature']),
      sel(cols,'signed_at',['signed_at']),
      sel(cols,'consent_signature',['consent_signature']),
      sel(cols,'consent_signed_at',['consent_signed_at']),
      sel(cols,'consent_snapshot',['consent_snapshot'])
    ]
    const idCol = (await getInvoiceCols(client)).has('id') ? 'id' : 'invoice_id'
    const sql = `
      SELECT ${selects.join(',\n             ')}
      FROM public.invoices i
      WHERE i.${qid(idCol)} = $1
      LIMIT 1
    `
    const r = await client.query(sql, [req.params.id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'get_invoice', message: err?.message || String(err) })
  } finally {
    client.release()
  }
})

// ---------- NEW: FULL invoice endpoint (ALL columns, no projection) ----------
app.get(['/api/invoices/:id/full', '/invoices/:id/full'], async (req, res) => {
  const client = await pool.connect()
  try {
    const id = Number(req.params.id || 0)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok:false, error:'bad_id' })
    const cols = await getInvoiceCols(client)
    const idCol = cols.has('id') ? 'id' : 'invoice_id'
    const sql = `SELECT * FROM public.invoices WHERE ${qid(idCol)} = $1 LIMIT 1`
    const r = await client.query(sql, [id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'get_invoice_full', message: err?.message || String(err) })
  } finally {
    client.release()
  }
})

app.post('/api/invoices', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    // Only insert keys that exist in your table
    const payload = req.body || {}
    const keys = Object.keys(payload).filter(k => has(cols, k))
    if (!keys.length) return res.status(400).json({ ok:false, error:'no_matching_columns' })

    const colSql = keys.map(k => qid(k)).join(', ')
    const valSql = keys.map((_,idx) => `$${idx+1}`).join(', ')
    const vals = keys.map(k => payload[k])

    const sql = `INSERT INTO public.invoices (${colSql}) VALUES (${valSql}) RETURNING *`
    const r = await client.query(sql, vals)

    // respond first
    res.status(201).json(r.rows[0])

    // then fire-and-forget — pass transient fields used for referral capture
    const refCtx = {
      ...r.rows[0],
      __raw_referral_code: req.body?.referral_code_raw || '',
      __remarks: req.body?.remarks || req.body?.notes || req.body?.comment || '',
      __franchisee_hint: req.body?.franchisee_code || ''
    }
    setImmediate(() => {
      try { sendForInvoice(refCtx) } catch (e) { /* never throw */ }
    })
  } catch (err) {
    res.status(500).json({ ok:false, where:'create_invoice', message: err?.message || String(err) })
  } finally {
    client.release()
  }
})

app.put('/api/invoices/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const payload = req.body || {}
    const keys = Object.keys(payload).filter(k => has(cols, k))
    if (!keys.length) return res.status(400).json({ ok:false, error:'no_matching_columns' })

    const sets = keys.map((k,idx) => `${qid(k)} = $${idx+1}`).join(', ')
    const vals = keys.map(k => payload[k])
    const idCol = has(cols,'id') ? 'id' : 'invoice_id'
    const sql = `UPDATE public.invoices SET ${sets} WHERE ${qid(idCol)} = $${keys.length+1} RETURNING *`
    const r = await client.query(sql, [...vals, req.params.id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'update_invoice', message: err?.message || String(err) })
  } finally {
    client.release()
  }
})

app.get('/api/summary', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const where = []
    const params = []
    let i = 1
    if (req.query.q) {
      const like = `%${String(req.query.q).split('%').join('')}%`
      const or = []
      if (has(cols,'vehicle_number')) or.push(`i."vehicle_number" ILIKE $${i}`)
      if (has(cols,'customer_name'))  or.push(`i."customer_name" ILIKE $${i}`)
      if (or.length) { where.push(`(${or.join(' OR ')})`); params.push(like); i++ }
    }
    if (req.query.from && has(cols,'created_at')) { where.push(`i."created_at"::date >= $${i++}`); params.push(req.query.from) }
    if (req.query.to   && has(cols,'created_at')) { where.push(`i."created_at"::date <= $${i++}`); params.push(req.query.to) }

    const sql = `
      SELECT
        COUNT(*)::int AS count,
        ${has(cols,'dosage_ml') ? `COALESCE(SUM(i."dosage_ml"::numeric),0)` : '0::numeric'} AS dosage_ml,
        ${has(cols,'total_before_gst') ? `COALESCE(SUM(i."total_before_gst"::numeric),0)` : (has(cols,'subtotal_ex_gst') ? `COALESCE(SUM(i."subtotal_ex_gst"::numeric),0)` : '0::numeric')} AS total_before_gst,
        ${has(cols,'gst_amount') ? `COALESCE(SUM(i."gst_amount"::numeric),0)` : '0::numeric'} AS gst_amount,
        ${has(cols,'total_with_gst') ? `COALESCE(SUM(i."total_with_gst"::numeric),0)` : (has(cols,'total_amount') ? `COALESCE(SUM(i."total_amount"::numeric),0)` : '0::numeric')} AS total_with_gst
      FROM public.invoices i
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `
    const r = await client.query(sql, params)
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'summary', message: err?.message || String(err) })
  } finally {
    client.release()
  }
})

// ------------ Test route: forward to Referrals (optional) ------------
app.post('/__wire/referrals/test', async (req, res) => {
  try {
    const key = req.get('X-REF-API-KEY') || process.env.REF_API_WRITER_KEY
    const body = req.body || {}

    const required = ['referrer_customer_code','referred_invoice_code','franchisee_code','invoice_amount_inr','invoice_date']
    const miss = required.filter(k => !body[k])
    if (miss.length) return res.status(400).json({ ok:false, error:'missing', fields: miss })

    const r = await postReferral(body, key)
    return res.status(r.ok ? 200 : 502).json(r)
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) })
  }
})

// ------------ Start server ------------
const port = process.env.PORT || 10000
app.listen(port, () => {
  console.log(`Billing API listening on :${port}`)
})
