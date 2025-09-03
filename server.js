// server.js — MaxTT Billing API (ESM)
// Summary fix v3: prefer first non-zero candidate; IST CSV filter; CSV header "MRP (₹/ml)"
import express from 'express'
import pkg from 'pg'
const { Pool } = pkg

const app = express()

// --- CORS ---
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

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// --- helpers ---
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

// --- health ---
app.get('/', (_req, res) => res.send('MaxTT Billing API is running'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// --- Admin export VIEW helper (unchanged) ---
app.get('/api/admin/create-view-auto', async (_req, res) => {
  const client = await pool.connect()
  try {
    const cols = await getInvoiceCols(client)
    const pick = (...xs) => xs.find(x => has(cols, x))
    const expr = (alias, cands) => {
      const f = pick(...cands)
      return f ? `i.${qid(f)}::text AS ${qid(alias)}` : `NULL::text AS ${qid(alias)}`
    }
    const selectParts = [
      expr('invoice_id',['id','invoice_id']),
      expr('invoice_number',['invoice_number','invoice_no','inv_no','bill_no','invoice']),
      expr('invoice_ts_ist',['invoice_ts_ist','created_at','invoice_date','createdon','created_on','date']),
      expr('franchisee_code',['franchisee_code','franchisee','franchise_code','franchisee_id']),
      expr('admin_code',['admin_code','admin']),
      expr('super_admin_code',['super_admin_code','superadmin_code','sa_code']),
      expr('customer_code',['customer_code','customer_id','customer','cust_code']),
      expr('referral_code',['referral_code','ref_code','referral']),
      expr('vehicle_no',['vehicle_no','vehicle_number','registration_no','reg_no','vehicle']),
      expr('vehicle_make_model',['vehicle_make_model','make_model','model','make']),
      expr('odometer_reading',['odometer_reading','odometer','odo','kms']),
      expr('tyre_size_fl',['tyre_size_fl','fl_tyre','tyre_fl']),
      expr('tyre_size_fr',['tyre_size_fr','fr_tyre','tyre_fr']),
      expr('tyre_size_rl',['tyre_size_rl','rl_tyre','tyre_rl']),
      expr('tyre_size_rr',['tyre_size_rr','rr_tyre','tyre_rr']),
      expr('total_qty_ml',['total_qty_ml','qty_ml','total_ml','quantity_ml','qty','dosage_ml']),
      expr('mrp_per_ml',['mrp_per_ml','price_per_ml','rate_per_ml','mrp_ml']),
      expr('installation_cost',['installation_cost','install_cost','labour','labour_cost']),
      expr('discount_amount',['discount_amount','discount','disc']),
      expr('subtotal_ex_gst',['subtotal_ex_gst','subtotal','sub_total','amount_before_tax','amount_ex_gst','pre_tax_total','total_before_gst']),
      expr('gst_rate',['gst_rate','tax_rate','gst_percent','gst']),
      expr('gst_amount',['gst_amount','tax_amount','gst_value']),
      expr('total_amount',['total_amount','grand_total','total','amount','total_with_gst']),
      expr('stock_level_at_start_l',['stock_level_at_start_l','stock_before','stock_at_start_l','stock_start_liters']),
      expr('gps_lat',['gps_lat','latitude','lat']),
      expr('gps_lng',['gps_lng','longitude','lng','lon']),
      expr('site_address_text',['site_address_text','address','site_address','location','customer_address']),
      expr('tread_depth_min_mm',['tread_depth_min_mm','tread_depth','min_tread_mm','tread_depth_mm']),
      expr('speed_rating',['speed_rating','speedrate','speed']),
      expr('created_by_user_id',['created_by_user_id','created_by','user_id']),
      'NULL::text AS "role"'
    ]
    await client.query(`
      CREATE OR REPLACE VIEW public.v_invoice_export AS
      SELECT ${selectParts.join(', ')}
      FROM public.invoices i;
    `)
    res.json({ ok: true, created: 'public.v_invoice_export' })
  } catch (e) {
    res.status(500).json({ ok:false, where:'create_view_auto', message:e?.message||String(e) })
  } finally { client.release() }
})

// --- CSV export (kept) ---
const csvField = v => v==null ? '' : (/["\n,\r;]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v))
function rowsToCsv(rows){
  const headers=['Invoice ID','Invoice No','Timestamp (IST)','Franchisee Code','Admin Code','SuperAdmin Code','Customer Code','Referral Code','Vehicle No','Make/Model','Odometer','Tyre Size FL','Tyre Size FR','Tyre Size RL','Tyre Size RR','Qty (ml)','MRP (₹/ml)','Installation Cost ₹','Discount ₹','Subtotal (ex-GST) ₹','GST Rate','GST Amount ₹','Total Amount ₹','Stock@Start (L)','GPS Lat','GPS Lng','Site Address','Min Tread Depth (mm)','Speed Rating','Created By UserId','Created By Role']
  const out=[headers.map(csvField).join(',')]
  for(const r of rows){
    out.push([
      r.invoice_id,r.invoice_number,r.invoice_ts_ist,r.franchisee_code,r.admin_code,r.super_admin_code,r.customer_code,r.referral_code,r.vehicle_no,r.vehicle_make_model,r.odometer_reading,r.tyre_size_fl,r.tyre_size_fr,r.tyre_size_rl,r.tyre_size_rr,r.total_qty_ml,r.mrp_per_ml,r.installation_cost,r.discount_amount,r.subtotal_ex_gst,r.gst_rate,r.gst_amount,r.total_amount,r.stock_level_at_start_l,r.gps_lat,r.gps_lng,r.site_address_text,r.tread_depth_min_mm,r.speed_rating,r.created_by_user_id,r.role
    ].map(csvField).join(','))
  }
  return out.join('\r\n')+'\r\n'
}
app.get('/api/exports/invoices', async (req,res)=>{
  try{
    const { from,to,franchisee,q } = req.query
    const where=[], params=[]; let i=1
    const fromSql='public.v_invoice_export'
    if(from){ where.push(`invoice_ts_ist::date >= $${i++}`); params.push(from) }
    if(to){ where.push(`invoice_ts_ist::date <= $${i++}`); params.push(to) }
    if(franchisee){ where.push(`franchisee_code = $${i++}`); params.push(franchisee) }
    if(q){ const like=`%${String(q).split('%').join('')}%`; where.push(`(vehicle_no ILIKE $${i} OR customer_code ILIKE $${i})`); params.push(like); i++ }
    const sql=`SELECT * FROM ${fromSql} ${where.length?('WHERE '+where.join(' AND ')):''} ORDER BY invoice_ts_ist DESC LIMIT 50000;`
    const client=await pool.connect()
    try{
      const r=await client.query(sql, params)
      const bom='\uFEFF'
      const now=new Date().toISOString().slice(0,19).replace(/[:T]/g,'')
      const wm=franchisee?`_${franchisee}`:''
      res.setHeader('Content-Type','text/csv; charset=utf-8')
      res.setHeader('Content-Disposition',`attachment; filename="maxtt_invoices_${now}${wm}.csv"`)
      res.setHeader('Cache-Control','no-store')
      res.status(200).send(bom + rowsToCsv(r.rows))
    } finally { client.release() }
  }catch(err){ res.status(500).json({ ok:false, error:'CSV export failed', message: err?.message || String(err) }) }
})

// --- SUMMARY (first non-zero candidate logic) ---
app.get('/api/summary', async (req,res)=>{
  const client=await pool.connect()
  try{
    const cols=await getInvoiceCols(client)
    const where=[], params=[]; let i=1
    const dateCol = has(cols,'invoice_ts_ist') ? 'invoice_ts_ist' : (has(cols,'created_at') ? 'created_at' : null)
    if (dateCol && req.query.from) { where.push(`i.${qid(dateCol)}::date >= $${i++}`); params.push(req.query.from) }
    if (dateCol && req.query.to)   { where.push(`i.${qid(dateCol)}::date <= $${i++}`); params.push(req.query.to) }

    // numeric cleaner (text -> trim -> strip non-numeric -> NULLIF '' -> numeric)
    const asNum = (col) => `NULLIF(regexp_replace(trim(i.${qid(col)}::text),'[^0-9.+-]','','g'),'')::numeric`

    // candidates
    const sumQtyTotal   = has(cols,'total_qty_ml')     ? `COALESCE(SUM(${asNum('total_qty_ml')}),0)`     : '0::numeric'
    const sumQtyDosage  = has(cols,'dosage_ml')        ? `COALESCE(SUM(${asNum('dosage_ml')}),0)`        : '0::numeric'

    const sumBefore     = has(cols,'total_before_gst') ? `COALESCE(SUM(${asNum('total_before_gst')}),0)` : '0::numeric'
    const sumSubtotal   = has(cols,'subtotal_ex_gst')  ? `COALESCE(SUM(${asNum('subtotal_ex_gst')}),0)`  : '0::numeric'
    const sumTotal      = has(cols,'total_with_gst')   ? `COALESCE(SUM(${asNum('total_with_gst')}),0)`   : '0::numeric'
    const sumGst        = has(cols,'gst_amount')       ? `COALESCE(SUM(${asNum('gst_amount')}),0)`       : '0::numeric'
    const sumDerived    = `GREATEST(${sumTotal} - ${sumGst}, 0)`

    // pick first non-zero
    const dosageExpr = `COALESCE(NULLIF(${sumQtyTotal},0), NULLIF(${sumQtyDosage},0), 0::numeric)`
    const revExpr    = `COALESCE(NULLIF(${sumBefore},0), NULLIF(${sumSubtotal},0), ${sumDerived}, 0::numeric)`
    const gstExpr    = `${sumGst}`
    const totalExpr  = `${sumTotal}`

    const sql = `
      SELECT
        COUNT(*)::int AS count,
        ${dosageExpr}      AS dosage_ml,
        ${revExpr}         AS total_before_gst,
        ${gstExpr}         AS gst_amount,
        ${totalExpr}       AS total_with_gst
      FROM public.invoices i
      ${where.length?('WHERE '+where.join(' AND ')):''}
    `
    const r=await client.query(sql, params)
    res.json(r.rows[0])
  }catch(err){
    res.status(500).json({ ok:false, where:'summary', message: err?.message || String(err) })
  } finally { client.release() }
})

// --- FULL invoice passthrough & create (unchanged minimal needed) ---
app.get(['/api/invoices/:id/full2','/invoices/:id/full2'], async (req,res)=>{
  const client=await pool.connect()
  try{
    const id=Number(req.params.id||0)
    if(!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'bad_id' })
    const cols=await getInvoiceCols(client)
    const idCol = cols.has('id') ? 'id' : 'invoice_id'
    const r = await client.query(`SELECT * FROM public.invoices WHERE ${qid(idCol)}=$1 LIMIT 1`, [id])
    if(!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.setHeader('Cache-Control','no-store')
    res.json(r.rows[0])
  }catch(err){ res.status(500).json({ ok:false, where:'get_invoice_full2', message: err?.message || String(err) }) }
  finally{ client.release() }
})

app.post('/api/invoices/full', async (req,res)=>{
  const client=await pool.connect()
  try{
    const payload = req.body || {}
    const cols = await getInvoiceCols(client)
    const accepted = [
      'franchisee_id','franchisee_code','customer_name','customer_gstin','customer_address','vehicle_number','vehicle_type',
      'tyre_count','fitment_locations','installer_name',
      'total_qty_ml','dosage_ml','mrp_per_ml','installation_cost','discount_amount',
      'subtotal_ex_gst','total_before_gst','gst_rate','gst_amount','total_with_gst',
      'tyre_width_mm','aspect_ratio','rim_diameter_in','tread_depth_min_mm','speed_rating',
      'tread_fl_mm','tread_fr_mm','tread_rl_mm','tread_rr_mm',
      'stock_level_at_start_l','site_address_text','hsn_code',
      'referral_code','customer_signature','signed_at','consent_signature','consent_signed_at','gps_lat','gps_lng',
    ]
    const keys = accepted.filter(k => payload[k] !== undefined && has(cols,k))
    if(!keys.length) return res.status(400).json({ ok:false, error:'no_matching_columns' })
    const sql = `INSERT INTO public.invoices (${keys.map(qid).join(', ')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(', ')}) RETURNING *`
    const r = await client.query(sql, keys.map(k => payload[k]))
    const row = r.rows[0]
    res.status(201).json({ ok:true, id: row?.id || row?.invoice_id, invoice_number: row?.invoice_number || null, customer_code: row?.customer_code || null })
  }catch(err){ res.status(400).json({ ok:false, error: err?.message || String(err) }) }
  finally{ client.release() }
})

// --- 404 ---
app.use((_req,res)=>res.status(404).json({ error:'not_found' }))

// --- start ---
const port = Number(process.env.PORT || 10000)
app.listen(port, ()=>{ console.log(`Billing API listening on :${port}`) })
