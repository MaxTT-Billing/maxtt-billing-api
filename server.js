// server.js — AUTO view creator (ESM, regex-free)
// It detects which columns exist in `invoices` and builds a matching view.
// Then CSV export works even if your column names are different.

import express from 'express'
import cors from 'cors'
import pkg from 'pg'
const { Pool } = pkg

const app = express()
app.use(cors())
app.use(express.json())

// --- DB connection (Render → Environment → DATABASE_URL) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// ---------- Simple test routes ----------
app.get('/', (_req, res) => res.send('MaxTT API is running'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// ---------- Diagnostics ----------
app.get('/api/diag/db', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW() AS now')
    res.json({ ok: true, db_time: r.rows[0].now })
  } catch (err) {
    res.status(500).json({ ok: false, where: 'db_connect', message: err?.message || String(err) })
  }
})

app.get('/api/diag/whoami', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT current_database() AS db, current_schema() AS schema`)
    const url = process.env.DATABASE_URL || ''
    let host = '', databaseFromUrl = ''
    try { const u = new URL(url); host = u.hostname; databaseFromUrl = (u.pathname || '').replace('/', '') } catch {}
    res.json({ ok: true, current_database: r.rows[0]?.db, current_schema: r.rows[0]?.schema, url_host: host, url_database: databaseFromUrl, ssl: true })
  } catch (err) {
    res.status(500).json({ ok: false, where: 'whoami', message: err?.message || String(err) })
  }
})

app.get('/api/diag/view', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT to_regclass('public.v_invoice_export') AS v`)
    const exists = r.rows[0]?.v
    if (!exists) return res.json({ ok: false, where: 'view_check', reason: 'view_missing' })
    res.json({ ok: true, view: String(exists) })
  } catch (err) {
    res.status(500).json({ ok: false, where: 'view_check', message: err?.message || String(err) })
  }
})

// ---------- CSV helpers (NO regex) ----------
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
  return lines.join('\r\n') + '\r\n' // Excel-friendly CRLF
}

// ---------- AUTO: create view that adapts to your columns ----------
app.get('/api/admin/create-view-auto', async (_req, res) => {
  const client = await pool.connect()
  try {
    // 1) Read columns from public.invoices
    const colsRes = await client.query(`
      SELECT lower(column_name) AS name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'invoices'
    `)
    const cols = new Set(colsRes.rows.map(r => r.name))

    const has = (name) => cols.has(String(name).toLowerCase())
    const pick = (...cands) => cands.find(c => has(c)) || null
    const qid = (name) => `"${name}"` // quote identifier
    const expr = (alias, candidates) => {
      const found = pick(...candidates)
      return found ? `i.${qid(found)}::text AS ${qid(alias)}` : `NULL::text AS ${qid(alias)}`
    }

    // 2) Build SELECT list with fallbacks (all cast to text for safety)
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
      expr('total_qty_ml', ['total_qty_ml','qty_ml','total_ml','quantity_ml','qty']),
      expr('mrp_per_ml', ['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']),
      expr('installation_cost', ['installation_cost','install_cost','labour','labour_cost']),
      expr('discount_amount', ['discount_amount','discount','disc']),
      expr('subtotal_ex_gst', ['subtotal_ex_gst','subtotal','sub_total','amount_before_tax','amount_ex_gst','pre_tax_total']),
      expr('gst_rate', ['gst_rate','tax_rate','gst_percent','gst']),
      expr('gst_amount', ['gst_amount','tax_amount','gst_value','tax']),
      expr('total_amount', ['total_amount','grand_total','total','amount']),
      expr('stock_level_at_start_l', ['stock_level_at_start_l','stock_before','stock_at_start_l','stock_start_liters']),
      expr('gps_lat', ['gps_lat','latitude','lat']),
      expr('gps_lng', ['gps_lng','longitude','lng','lon']),
      expr('site_address_text', ['site_address_text','address','site_address','location']),
      expr('tread_depth_min_mm', ['tread_depth_min_mm','tread_depth','min_tread_mm']),
      expr('speed_rating', ['speed_rating','speedrate','speed']),
      expr('created_by_user_id', ['created_by_user_id','created_by','user_id']),
      'NULL::text AS "role"' // lite: no users table
    ]

    const createViewSql = `
      CREATE OR REPLACE VIEW public.v_invoice_export AS
      SELECT
        ${selectParts.join(',\n        ')}
      FROM public.invoices i;
    `
    await client.query(createViewSql)
    res.json({ ok: true, created: 'public.v_invoice_export', used_columns: Array.from(cols).sort() })
  } catch (err) {
    res.status(500).json({ ok: false, where: 'create_view_auto', message: err?.message || String(err) })
  } finally {
    client.release()
  }
})

// ---------- CSV export ----------
app.get('/api/exports/invoices', async (req, res) => {
  try {
    const { from, to, franchisee, q } = req.query

    const where = []
    const params = []
    let i = 1

    if (from) { where.push(`invoice_ts_ist::date >= $${i++}`); params.push(from) }
    if (to)   { where.push(`invoice_ts_ist::date <= $${i++}`); params.push(to) }
    if (franchisee) { where.push(`franchisee_code = $${i++}`); params.push(franchisee) }
    if (q) {
      const like = `%${String(q).split('%').join('')}%`
      where.push(`(vehicle_no ILIKE $${i} OR customer_code ILIKE $${i})`)
      params.push(like); i++
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sql = `SELECT * FROM public.v_invoice_export ${whereSql} ORDER BY invoice_ts_ist DESC LIMIT 50000;`

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
    res.status(500).json({ ok: false, error: 'CSV export failed', message: err?.message || String(err) })
  }
})

// ---------- Start server ----------
const port = process.env.PORT || 3001
app.listen(port, () => {
  console.log(`API listening on :${port}`)
})
