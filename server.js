// server.js — MaxTT Billing API (ESM)
// ✅ NEW: Dosage (ml) is computed at CREATE time (POST /api/invoices/full) and saved.
//    - Computes from money fields (ex-GST, installation, discount, unit price).
//    - Tyre-field formula can be added later, but this immediately fixes Admin tiles.
// ✅ /api/summary now sums stored dosage columns; falls back to safe per-row math only if needed.
// ✅ Robust column-name discovery across existing schemas (install_cost vs installation_cost etc.)
// ✅ Keeps health, CSV export, list/get, full2 passthrough, simple auth/profile, referrals test.
// ---------------------------------------------------------------------------------------------

import express from 'express'
import pkg from 'pg'
const { Pool } = pkg

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
    WHERE table_schema = 'public' AND table_name = 'invoices'
  `)
  cachedCols = new Set(r.rows.map(x => x.name))
  return cachedCols
}
const has = (cols, n) => cols.has(String(n).toLowerCase())
const qid = (n) => `"${n}"`

function findCol(cols, candidates) {
  for (const c of candidates) if (has(cols, c)) return c
  return null
}
function cleanNumeric(colSql) {
  // strips currency symbols, spaces, commas; keeps digits . + -
  return `NULLIF(regexp_replace(trim(${colSql}::text),'[^0-9.+-]','','g'),'')::numeric`
}

// For SELECT lists with graceful NULLs
function sel(cols, alias, candidates, type = 'text') {
  const found = findCol(cols, candidates)
  return found ? `i.${qid(found)}::${type} AS ${qid(alias)}` : `NULL::${type} AS ${qid(alias)}`
}

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
      expr('invoice_ts_ist', ['invoice_ts_ist','created_at','invoice_date','createdon','created_on','date']),
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
      expr('total_amount', ['total_with_gst','total_amount','grand_total','total','amount']),
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

// ----------------------- Invoices list & get ---------------------------
app.get('/api/invoices', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const selects = [
      sel(cols, 'id', ['id','invoice_id']),
      sel(cols, 'created_at', ['created_at','invoice_ts_ist','invoice_date','date','createdon','created_on']),
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
      const or = []
      if (findCol(cols,['vehicle_number','vehicle_no','registration_no','reg_no'])) or.push(`i.${qid(findCol(cols,['vehicle_number','vehicle_no','registration_no','reg_no']))} ILIKE $${i}`)
      if (findCol(cols,['customer_name','customer']))  or.push(`i.${qid(findCol(cols,['customer_name','customer']))} ILIKE $${i}`)
      if (or.length) { where.push(`(${or.join(' OR ')})`); params.push(like); i++ }
    }
    const dateCol = findCol(cols,['invoice_ts_ist','created_at','invoice_date','date','createdon','created_on'])
    if (req.query.from && dateCol) { where.push(`i.${qid(dateCol)}::date >= $${i++}`); params.push(req.query.from) }
    if (req.query.to   && dateCol) { where.push(`i.${qid(dateCol)}::date <= $${i++}`); params.push(req.query.to) }

    const limit = Math.min(Number(req.query.limit || 500), 5000)
    const sql = `
      SELECT ${selects.join(', ')}
      FROM public.invoices i
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY 1 DESC
      LIMIT ${limit}
    `
    const r = await client.query(sql, params)
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ ok:false, where:'list_invoices', message: err?.message || String(err) })
  } finally { client.release() }
})

app.get('/api/invoices/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const selects = [
      sel(cols,'id',['id','invoice_id']),
      sel(cols,'created_at',['created_at','invoice_ts_ist','invoice_date','date','createdon','created_on']),
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
      sel(cols,'dosage_ml',['total_qty_ml','dosage_ml','qty_ml','total_ml','quantity_ml','qty']),
      sel(cols,'price_per_ml',['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']),
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
    const idCol = findCol(cols,['id','invoice_id']) || 'id'
    const sql = `
      SELECT ${selects.join(', ')}
      FROM public.invoices i
      WHERE i.${qid(idCol)} = $1
      LIMIT 1
    `
    const r = await client.query(sql, [req.params.id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'get_invoice', message: err?.message || String(err) })
  } finally { client.release() }
})

// ------------------------ FULL passthrough (/full2) --------------------
app.get(['/api/invoices/:id/full2', '/invoices/:id/full2'], async (req, res) => {
  const client = await pool.connect()
  try {
    const id = Number(req.params.id || 0)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok:false, error:'bad_id' })
    const cols = await getInvoiceCols(client)
    const idCol = findCol(cols,['id','invoice_id']) || 'id'
    const r = await client.query(`SELECT * FROM public.invoices WHERE ${qid(idCol)} = $1 LIMIT 1`, [id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.setHeader('Cache-Control','no-store')
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'get_invoice_full2', message: err?.message || String(err) })
  } finally { client.release() }
})

// ---------------------- BASIC create / update (legacy) -----------------
app.post('/api/invoices', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const payload = req.body || {}
    const keys = Object.keys(payload).filter(k => has(cols, k))
    if (!keys.length) return res.status(400).json({ ok:false, error:'no_matching_columns' })

    const sql = `INSERT INTO public.invoices (${keys.map(qid).join(', ')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(', ')}) RETURNING *`
    const r = await client.query(sql, keys.map(k => payload[k]))
    res.status(201).json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'create_invoice', message: err?.message || String(err) })
  } finally { client.release() }
})

app.put('/api/invoices/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const payload = req.body || {}
    const keys = Object.keys(payload).filter(k => has(cols, k))
    if (!keys.length) return res.status(400).json({ ok:false, error:'no_matching_columns' })

    const sets = keys.map((k,idx) => `${qid(k)} = $${idx+1}`).join(', ')
    const idCol = findCol(cols,['id','invoice_id']) || 'id'
    const sql = `UPDATE public.invoices SET ${sets} WHERE ${qid(idCol)} = $${keys.length+1} RETURNING *`
    const r = await client.query(sql, [...keys.map(k => payload[k]), req.params.id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'update_invoice', message: err?.message || String(err) })
  } finally { client.release() }
})

// ----------------------------- SUMMARY ---------------------------------
// Sums saved dosage. Only falls back to derived math if dosage columns are null.
app.get('/api/summary', async (req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const where = []; const params = []; let i = 1

    const dateCol = findCol(cols,['invoice_ts_ist','created_at','invoice_date','date','createdon','created_on'])
    if (dateCol && req.query.from) { where.push(`i.${qid(dateCol)}::date >= $${i++}`); params.push(req.query.from) }
    if (dateCol && req.query.to)   { where.push(`i.${qid(dateCol)}::date <= $${i++}`); params.push(req.query.to) }
    const whereSql = where.length ? 'WHERE '+where.join(' AND ') : ''

    const qtyCol = findCol(cols,['total_qty_ml','dosage_ml','qty_ml','total_ml','quantity_ml','qty'])
    const unitPriceCol = findCol(cols,['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml'])
    const installCol = findCol(cols,['installation_cost','install_cost','labour','labour_cost'])
    const discountCol = findCol(cols,['discount_amount','discount','disc'])
    const exBeforeCol = findCol(cols,['total_before_gst','subtotal_ex_gst','subtotal','amount_before_tax'])
    const totalWithGstCol = findCol(cols,['total_with_gst','total_amount','grand_total','total'])
    const gstCol = findCol(cols,['gst_amount','tax_amount','gst_value'])

    const FALLBACK_MRP = Number(process.env.FALLBACK_MRP_PER_ML || 4.5).toFixed(6)

    const qtyExpr = qtyCol
      ? `NULLIF(${cleanNumeric(`i.${qid(qtyCol)}`)},0)`
      : `NULL` // no saved qty => fallback later in SQL

    const unitExpr = unitPriceCol
      ? `NULLIF(${cleanNumeric(`i.${qid(unitPriceCol)}`)},0)`
      : `${FALLBACK_MRP}::numeric`

    const exExpr = exBeforeCol
      ? `${cleanNumeric(`i.${qid(exBeforeCol)}`)}`
      : `GREATEST(COALESCE(${totalWithGstCol ? cleanNumeric(`i.${qid(totalWithGstCol)}`) : 'NULL'},0) - COALESCE(${gstCol ? cleanNumeric(`i.${qid(gstCol)}`) : 'NULL'},0), 0)`

    const installExpr = installCol ? `COALESCE(${cleanNumeric(`i.${qid(installCol)}`)},0)` : '0::numeric'
    const discountExpr = discountCol ? `COALESCE(${cleanNumeric(`i.${qid(discountCol)}`)},0)` : '0::numeric'
    const productExExpr = `GREATEST( (${exExpr}) - (${installExpr}) + (${discountExpr}), 0 )`

    const derivedQty = `CASE WHEN ${qtyExpr} IS NOT NULL THEN ${qtyExpr}
                         WHEN (${unitExpr}) IS NOT NULL AND (${unitExpr}) <> 0
                           THEN (${productExExpr}) / (${unitExpr})
                         ELSE 0::numeric END`

    const gstSum = gstCol ? `COALESCE(SUM(${cleanNumeric(`i.${qid(gstCol)}`)}),0)` : '0::numeric'
    const totalSum = totalWithGstCol ? `COALESCE(SUM(${cleanNumeric(`i.${qid(totalWithGstCol)}`)}),0)` : '0::numeric'
    const beforeSum = exBeforeCol ? `COALESCE(SUM(${cleanNumeric(`i.${qid(exBeforeCol)}`)}),0)` : '0::numeric'
    const subtotalSum = (exBeforeCol ? null : findCol(cols,['subtotal_ex_gst','subtotal','amount_before_tax']))
      ? `COALESCE(SUM(${cleanNumeric(`i.${qid(findCol(cols,['subtotal_ex_gst','subtotal','amount_before_tax']))}`)}),0)`
      : '0::numeric'

    const sql = `
      WITH base AS (
        SELECT ${derivedQty} AS qty_ml
        FROM public.invoices i
        ${whereSql}
      )
      SELECT
        (SELECT COUNT(*)::int FROM public.invoices i ${whereSql}) AS count,
        COALESCE(SUM(qty_ml),0) AS dosage_ml,
        COALESCE(
          NULLIF((SELECT ${beforeSum} FROM public.invoices i ${whereSql}), 0),
          NULLIF((SELECT ${subtotalSum} FROM public.invoices i ${whereSql}), 0),
          GREATEST(
            (SELECT ${totalSum} FROM public.invoices i ${whereSql}) -
            (SELECT ${gstSum}   FROM public.invoices i ${whereSql}),
            0
          )
        ) AS total_before_gst,
        (SELECT ${gstSum}   FROM public.invoices i ${whereSql}) AS gst_amount,
        (SELECT ${totalSum} FROM public.invoices i ${whereSql}) AS total_with_gst
      FROM base;
    `
    const r = await client.query(sql, params)
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ ok:false, where:'summary', message: err?.message || String(err) })
  } finally { client.release() }
})

// ------------------------ CREATE (authoritative) -----------------------
// Calculates dosage from money fields and saves into total_qty_ml (and dosage_ml if exists).
app.post('/api/invoices/full', async (req, res) => {
  const client = await pool.connect()
  try {
    const payload = req.body || {}
    const cols = await getInvoiceCols(client)

    // Discover column names present
    const qtyCols = ['total_qty_ml','dosage_ml','qty_ml','total_ml','quantity_ml','qty']
    const qtyColInTable = findCol(cols, qtyCols)
    const unitPriceCol = findCol(cols,['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']) || 'mrp_per_ml'
    const installCol = findCol(cols,['installation_cost','install_cost','labour','labour_cost']) || 'installation_cost'
    const discountCol = findCol(cols,['discount_amount','discount','disc']) || 'discount_amount'
    const exBeforeCol = findCol(cols,['total_before_gst','subtotal_ex_gst','subtotal','amount_before_tax'])
    const totalWithGstCol = findCol(cols,['total_with_gst','total_amount','grand_total','total'])
    const gstCol = findCol(cols,['gst_amount','tax_amount','gst_value'])

    // Pull numbers from payload, with cleaning
    const asNum = (v) => {
      if (v === null || v === undefined) return null
      const s = String(v).trim().replace(/[^0-9.+-]/g,'')
      if (s === '') return null
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }

    const unitPrice = asNum(payload[unitPriceCol]) ?? Number(process.env.FALLBACK_MRP_PER_ML || 4.5)
    const install = asNum(payload[installCol]) ?? 0
    const discount = asNum(payload[discountCol]) ?? 0

    let exBefore = asNum(payload[exBeforeCol])
    if (exBefore == null) {
      const totalWithGst = asNum(payload[totalWithGstCol])
      const gst = asNum(payload[gstCol])
      if (totalWithGst != null && gst != null) exBefore = Math.max(totalWithGst - gst, 0)
    }

    // If qty provided explicitly, keep it; else compute from product value
    let qtyProvided = null
    for (const k of qtyCols) if (payload[k] != null) { qtyProvided = asNum(payload[k]); break }

    let computedQty = qtyProvided
    if (computedQty == null && exBefore != null && unitPrice) {
      const productEx = Math.max(exBefore - (install || 0) + (discount || 0), 0)
      computedQty = unitPrice ? (productEx / unitPrice) : null
    }

    // Prepare insert payload — include computed qty under the first available qty column
    const accepted = [
      'franchisee_id','franchisee_code','customer_name','customer_gstin','customer_address','vehicle_number','vehicle_type',
      'tyre_count','fitment_locations','installer_name',
      // qty columns
      ...qtyCols,
      // price/tax
      'mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml',
      'installation_cost','install_cost','labour','labour_cost',
      'discount_amount','discount','disc',
      'subtotal_ex_gst','total_before_gst','gst_rate','gst_amount','total_with_gst',
      // tyre / misc
      'tyre_width_mm','aspect_ratio','rim_diameter_in','tread_depth_min_mm','speed_rating',
      'tread_fl_mm','tread_fr_mm','tread_rl_mm','tread_rr_mm',
      'stock_level_at_start_l','site_address_text','hsn_code',
      'referral_code','customer_signature','signed_at','consent_signature','consent_signed_at','gps_lat','gps_lng',
    ]
    const insertPayload = {}
    for (const k of accepted) if (payload[k] !== undefined && has(cols,k)) insertPayload[k] = payload[k]

    if (computedQty != null) {
      if (qtyColInTable) {
        insertPayload[qtyColInTable] = computedQty
      } else if (has(cols,'total_qty_ml')) {
        insertPayload['total_qty_ml'] = computedQty
      } else if (has(cols,'dosage_ml')) {
        insertPayload['dosage_ml'] = computedQty
      }
    }

    const keys = Object.keys(insertPayload)
    if (!keys.length) return res.status(400).json({ ok:false, error:'no_matching_columns' })

    const sql = `INSERT INTO public.invoices (${keys.map(qid).join(', ')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(', ')}) RETURNING *`
    const r = await client.query(sql, keys.map(k => insertPayload[k]))
    const row = r.rows[0]
    res.status(201).json({
      ok: true,
      id: row?.id ?? row?.invoice_id ?? null,
      invoice_number: row?.invoice_number ?? null,
      customer_code: row?.customer_code ?? null,
      qty_ml_saved: computedQty ?? qtyProvided ?? null
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

    // Lazy import to avoid ESM export shape issues
    let postReferralFn = null
    try {
      const mod = await import('./referralsClient.js')
      postReferralFn = mod.postReferral || mod.default
    } catch (_) {}
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
