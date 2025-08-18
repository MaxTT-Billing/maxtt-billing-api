const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')

const app = express()
app.use(cors())
app.use(express.json())

// Postgres pool (Render/Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// CSV helpers
const CSV_HEADERS = [
  'Invoice ID','Invoice No','Timestamp (IST)','Franchisee Code','Admin Code','SuperAdmin Code',
  'Customer Code','Referral Code','Vehicle No','Make/Model','Odometer',
  'Tyre Size FL','Tyre Size FR','Tyre Size RL','Tyre Size RR',
  'Qty (ml)','MRP (/ml ₹)','Installation Cost ₹','Discount ₹','Subtotal (ex-GST) ₹',
  'GST Rate','GST Amount ₹','Total Amount ₹',
  'Stock@Start (L)','GPS Lat','GPS Lng','Site Address','Min Tread Depth (mm)','Speed Rating',
  'Created By UserId','Created By Role'
]

function toCsvRow(fields) {
  return fields
    .map((v) => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      const mustQuote = /[",

;]/.test(s) || s.includes(',')
      const escaped = s.replace(/"/g, '""')
      return mustQuote ? `"${escaped}"` : escaped
    })
    .join(',')
}

function rowsToCsv(rows) {
  const header = toCsvRow([...CSV_HEADERS])
  const data = rows.map((r) =>
    toCsvRow([
      r.invoice_id,
      r.invoice_number,
      r.invoice_ts_ist,
      r.franchisee_code,
      r.admin_code,
      r.super_admin_code,
      r.customer_code,
      r.referral_code,
      r.vehicle_no,
      r.vehicle_make_model,
      r.odometer_reading,
      r.tyre_size_fl,
      r.tyre_size_fr,
      r.tyre_size_rl,
      r.tyre_size_rr,
      r.total_qty_ml,
      r.mrp_per_ml,
      r.installation_cost,
      r.discount_amount,
      r.subtotal_ex_gst,
      r.gst_rate,
      r.gst_amount,
      r.total_amount,
      r.stock_level_at_start_l,
      r.gps_lat,
      r.gps_lng,
      r.site_address_text,
      r.tread_depth_min_mm,
      r.speed_rating,
      r.created_by_user_id,
      r.role,
    ])
  )
  return [header, ...data].join('
') + '
'
}

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// CSV export endpoint
app.get('/api/exports/invoices', async (req, res) => {
  try {
    const { from, to, franchisee, q } = req.query

    const where = []
    const params = []
    let i = 1

    if (from) { where.push(`invoice_ts_ist::date >= $${i++}`); params.push(from) }
    if (to) { where.push(`invoice_ts_ist::date <= $${i++}`); params.push(to) }
    if (franchisee) { where.push(`franchisee_code = $${i++}`); params.push(franchisee) }
    if (q) {
      const like = `%${String(q).replace(/%/g, '')}%`
      where.push(`(vehicle_no ILIKE $${i} OR customer_code ILIKE $${i})`)
      params.push(like); i++
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `SELECT * FROM v_invoice_export ${whereSql} ORDER BY invoice_ts_ist DESC LIMIT 50000;`

    const client = await pool.connect()
    try {
      const result = await client.query(sql, params)
      const csv = rowsToCsv(result.rows)
      const bom = '﻿'

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
    console.error('CSV export failed', err)
    res.status(500).json({ ok: false, error: 'CSV export failed' })
  }
})

const port = process.env.PORT || 3001
app.listen(port, () => {
  console.log(`API listening on :${port}`)
})
