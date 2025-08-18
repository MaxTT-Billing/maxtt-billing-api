// server.js — Lite version (ESM, regex-free)
// Use when your DB does NOT have a `users` table.
// It creates a view that only reads from `invoices` and sets role = NULL.

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

// ---------- CREATE VIEW (LITE) — no users table needed ----------
const CREATE_VIEW_LITE_SQL = `
CREATE OR REPLACE VIEW public.v_invoice_export AS
SELECT
  i.id                        AS invoice_id,
  i.invoice_number,
  (i.created_at AT TIME ZONE 'Asia/Kolkata') AS invoice_ts_ist,
  i.franchisee_code,
  i.admin_code,
  i.super_admin_code,
  i.customer_code,
  i.referral_code,
  i.vehicle_no,
  i.vehicle_make_model,
  i.odometer_reading,
  i.tyre_size_fl,
  i.tyre_size_fr,
  i.tyre_size_rl,
  i.tyre_size_rr,
  i.total_qty_ml,
  i.mrp_per_ml,
  i.installation_cost,
  i.discount_amount,
  i.subtotal_ex_gst,
  i.gst_rate,
  i.gst_amount,
  i.total_amount,
  i.stock_level_at_start_l,
  i.gps_lat,
  i.gps_lng,
  i.site_address_text,
  i.tread_depth_min_mm,
  i.speed_rating,
  i.created_by_user_id,
  NULL::text AS role
FROM invoices i;
`;

app.get('/api/admin/create-view-lite', async (_req, res) => {
  try {
    await pool.query(CREATE_VIEW_LITE_SQL)
    res.json({ ok: true, created: 'public.v_invoice_export' })
  } catch (err) {
    res.status(500).json({ ok: false, where: 'create_view_lite', message: err?.message || String(err) })
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
