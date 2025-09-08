// server.js — Treadstone Solutions / MaxTT Billing API (ESM)
// NOTE: PDF matches 5-zone layout from Invoice #46; Zone-2 includes HSN Code + Customer ID.
// No TS logo, no watermark; intended for printing on pre-watermarked sheets.

import express from 'express'
import pkg from 'pg'
const { Pool } = pkg
import { fileURLToPath } from 'url'
import path from 'path'
import PDFDocument from 'pdfkit' // PDF generation

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()

// ------------------------------- CORS ---------------------------------
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://maxtt-billing-tools.onrender.com,https://maxtt-billing-frontend.onrender.com')
  .split(',').map(s => s.trim()).filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin || ''
  if (ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-REF-API-KEY, X-SA-KEY, X-ADMIN-KEY, X-SA-USER, X-ADMIN-USER')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

app.use(express.json({ limit: '15mb' }))

// ------------------------------- DB -----------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// --------------------------- Helpers ----------------------------------
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
function findCol(cols, candidates){ for(const c of candidates) if (has(cols,c)) return c; return null }
const pad = (n,w=4)=>String(Math.max(0,Number(n)||0)).padStart(w,'0')

function inr(n, digits=2){
  if (n == null) return 'Rs. 0.00'
  const v = Number(n)
  if (!isFinite(v)) return String(n)
  return 'Rs. ' + v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
function mmYY(d = new Date()){
  const mm = String(d.getUTCMonth()+1).padStart(2,'0')
  const yy = String(d.getUTCFullYear()).slice(-2)
  return `${mm}${yy}`
}
function printedFromNorm(norm) {
  if (!norm || typeof norm !== "string") return null
  const m = norm.match(/^(.*)-(\d{4})$/)
  if (!m) return null
  const prefix = m[1]
  const seq = m[2]
  return `${prefix}/${mmYY()}/${seq}`
}
function safe(v, alt='—'){ return (v === null || v === undefined || String(v).trim()==='') ? alt : String(v) }

// ------------------------------- Health --------------------------------
app.get('/', (_req,res)=>res.send('MaxTT Billing API is running'))
app.get('/api/health', (_req,res)=>res.json({ ok:true }))

// ------------------------------- Auth ----------------------------------
function requireSA(req,res,next){
  const key = req.get('X-SA-KEY') || ''
  const expect = process.env.SUPER_ADMIN_KEY || ''
  if (!expect) return res.status(500).json({ ok:false, error:'super_admin_key_not_set' })
  if (key !== expect) return res.status(401).json({ ok:false, error:'unauthorized' })
  next()
}
function requireAdmin(req,res,next){
  const key = req.get('X-ADMIN-KEY') || ''
  const expect = process.env.ADMIN_KEY || ''
  if (!expect) return res.status(500).json({ ok:false, error:'admin_key_not_set' })
  if (key !== expect) return res.status(401).json({ ok:false, error:'unauthorized' })
  next()
}

// ---------------------- Invoices: create -------------------------------
app.post('/api/invoices/full', async (req,res)=>{
  const client = await pool.connect()
  try{
    const body = req.body || {}
    const franchisee_id = String(body.franchisee_id || body.franchiseeId || '').trim()
    const tyre_width_mm = Number(body.tyre_width_mm || 195)
    const rim_diameter_in = Number(body.rim_diameter_in || 15)
    const tyre_count = Number(body.tyre_count || 4)

    if (!franchisee_id) return res.status(400).json({ ok:false, error:'missing_franchisee_id' })

    const DEFAULT_QTY_ML = Number(process.env.DEFAULT_QTY_ML || 1200)
    const MRP_PER_ML = Number(process.env.MRP_PER_ML || process.env.FALLBACK_MRP_PER_ML || 4.5)
    const total_before_gst = Math.round(DEFAULT_QTY_ML * MRP_PER_ML)
    const gst_amount = Math.round(total_before_gst * 0.18)
    const total_with_gst = total_before_gst + gst_amount

    const cols = await getInvoiceCols(client)
    const fcol = findCol(cols,['franchisee_id','franchisee_code']) || 'franchisee_id'
    const idCol = findCol(cols,['id','invoice_id']) || 'id'
    const seqQ = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.invoices WHERE ${qid(fcol)}=$1`, [franchisee_id]
    )
    const seq = (seqQ.rows?.[0]?.c || 0) + 1
    const seqStr = pad(seq,4)
    const invoice_number_norm = `${franchisee_id}-${seqStr}`
    const invoice_number = `${franchisee_id}/${mmYY()}/${seqStr}`

    const r = await client.query(`
      INSERT INTO public.invoices
      (${qid(fcol)},"invoice_number_norm","invoice_number","tyre_count","tyre_width_mm","rim_diameter_in",
       "dosage_ml","price_per_ml","total_before_gst","gst_amount","total_with_gst","hsn_code","gst_rate","created_at")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
      RETURNING ${qid(idCol)} AS id, "customer_code","invoice_number_norm","invoice_number"
    `,[
      franchisee_id, invoice_number_norm, invoice_number, tyre_count, tyre_width_mm, rim_diameter_in,
      DEFAULT_QTY_ML, MRP_PER_ML, total_before_gst, gst_amount, total_with_gst, '35069999', 18
    ])

    const row = r.rows[0]
    res.status(201).json({
      ok:true,
      id: row.id,
      invoice_number: row.invoice_number,
      invoice_number_norm: row.invoice_number_norm,
      customer_code: row.customer_code || invoice_number_norm,
      qty_ml_saved: DEFAULT_QTY_ML
    })
  }catch(err){
    res.status(500).json({ ok:false, where:'create_invoice', message: err?.message || String(err) })
  }finally{ client.release() }
})

// ---------------------- Invoices: list / latest / full2 / by-norm ------
app.get('/api/invoices', async (req,res)=>{
  const client=await pool.connect()
  try{
    const cols=await getInvoiceCols(client)
    const dcol=findCol(cols,['id','invoice_id','created_at']) || 'id'
    const params=[]
    const where=[]
    if (req.query.franchisee_id) { where.push(`${qid('franchisee_id')} = $${params.length+1}`); params.push(req.query.franchisee_id) }
    const sql=`
      SELECT i.*
      FROM public.invoices i
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      ORDER BY i.${qid(dcol)} DESC
      LIMIT ${Math.min(Number(req.query.limit||500),5000)}
    `
    const r=await client.query(sql,params)
    res.json(r.rows)
  }catch(err){
    res.status(500).json({ ok:false, where:'list_invoices', message: err?.message || String(err) })
  }finally{ client.release() }
})
app.get('/api/invoices/latest', async (_req,res)=>{
  const client=await pool.connect()
  try{
    const cols=await getInvoiceCols(client)
    const idCol=findCol(cols,['id','invoice_id']) || 'id'
    const r=await client.query(`SELECT ${qid(idCol)} AS id FROM public.invoices ORDER BY ${qid(idCol)} DESC LIMIT 1`)
    if(!r.rows.length) return res.status(404).json({ ok:false, error:'empty' })
    res.json({ id:r.rows[0].id })
  }catch(err){
    res.status(500).json({ ok:false, where:'latest', message: err?.message || String(err) })
  }finally{ client.release() }
})
app.get(['/api/invoices/:id/full2','/invoices/:id/full2'], async (req,res)=>{
  const client=await pool.connect()
  try{
    const id=Number(req.params.id||0)
    if (!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'bad_id' })
    const r=await client.query(`SELECT * FROM public.invoices WHERE id=$1 LIMIT 1`,[id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.setHeader('Cache-Control','no-store')
    const doc=r.rows[0]
    // If printed missing but norm exists, compute on-the-fly for response
    const printed = doc.invoice_number || (doc.invoice_number_norm ? printedFromNorm(doc.invoice_number_norm) : null)
    res.json(printed ? { ...doc, invoice_number: printed } : doc)
  }catch(err){
    res.status(500).json({ ok:false, where:'get_invoice_full2', message: err?.message || String(err) })
  }finally{ client.release() }
})
app.get('/api/invoices/by-norm/:norm', async (req,res)=>{
  const client=await pool.connect()
  try{
    const norm=String(req.params.norm||'').trim()
    if(!norm) return res.status(400).json({ ok:false, error:'missing_norm' })
    const r=await client.query(`SELECT * FROM public.invoices WHERE "invoice_number_norm"=$1 LIMIT 1`,[norm])
    if(!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json(r.rows[0])
  }catch(err){
    res.status(500).json({ ok:false, where:'by_norm', message: err?.message || err })
  }finally{ client.release() }
})

// ------------------------------- PDF (5 zones, no logo/watermark) ------
app.get('/api/invoices/:id/pdf', async (req,res)=>{
  const id = Number(req.params.id || 0)
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error:'bad_id' })

  const download = String(req.query.download||'').trim() === '1'

  const client = await pool.connect()
  try{
    // Invoice row
    const ir = await client.query(`SELECT * FROM public.invoices WHERE id=$1 LIMIT 1`, [id])
    if (!ir.rows.length) return res.status(404).json({ error:'not_found' })
    const inv = ir.rows[0]

    // Franchisee row (for header details)
    const frCode = inv.franchisee_id || inv.franchisee_code || ''
    let fr = null
    if (frCode) {
      const frq = await client.query(`SELECT * FROM public.franchisees WHERE code=$1 LIMIT 1`, [frCode])
      fr = frq.rows[0] || null
    }

    const printed = inv.invoice_number || printedFromNorm(inv.invoice_number_norm) || `INV-${id}`
    const cdisp = download ? 'attachment' : 'inline'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `${cdisp}; filename="${printed}.pdf"`)

    const doc = new PDFDocument({ size:'A4', margin:36 }) // slightly tighter margin to fit 5 zones neatly
    doc.pipe(res)

    // ---------- Zone 1: Franchisee Header (no logo) ----------
    // Use franchisee info if present; else placeholders
    doc.fontSize(12).text(safe(fr?.legal_name, 'Franchisee'), { continued:false, align:'left' })
    doc.moveDown(0.15)
    const addr = [fr?.address1, fr?.address2].filter(Boolean).join(', ')
    doc.fontSize(9).text(safe(addr,'Address not set'))
    const idLine = `Franchisee ID: ${safe(frCode)}`
    const gstLine = `GSTIN: ${safe(fr?.gstin,'')}`
    doc.text(idLine + (gstLine.endsWith(': ') ? '' : '    ' + gstLine))
    doc.moveDown(0.4)

    // Right-side meta: Invoice No / Date box
    const rightX = 380, topY = 36
    doc.roundedRect(rightX, topY, 180, 60, 6).stroke()
    doc.fontSize(10)
    doc.text(`Invoice No: ${printed}`, rightX+8, topY+8, { width:164 })
    const dt = new Date(inv.created_at || Date.now())
    const when = dt.toLocaleString('en-IN', { hour12:false, timeZone: 'Asia/Kolkata' }).replace(',', '')
    doc.text(`Date: ${when} IST`, rightX+8, topY+28, { width:164 })

    doc.moveDown(0.6)

    // ---------- Zone 2: Customer Details (+ HSN Code + Customer ID) ----------
    const z2Y = doc.y
    doc.roundedRect(36, z2Y, 524, 82, 6).stroke()
    doc.fontSize(10)
    doc.text(`Customer Name: ${safe(inv.customer_name)}`, 44, z2Y+8, { width: 250 })
    doc.text(`Mobile: ${safe(inv.mobile_number)}`, 300, z2Y+8, { width: 250 })
    doc.text(`Vehicle: ${safe(inv.vehicle_number)}`, 44, z2Y+26, { width: 250 })
    doc.text(`Odometer: ${safe(inv.odometer)} km`, 300, z2Y+26, { width: 250 })
    doc.text(`Address: ${safe(inv.customer_address)}`, 44, z2Y+44, { width: 250 })
    doc.text(`Installer: ${safe(inv.installer_name)}`, 300, z2Y+44, { width: 250 })
    // additions per spec:
    const hsn = inv.hsn_code || '35069999'
    doc.text(`HSN Code: ${hsn}`, 44, z2Y+62, { width: 250 })
    doc.text(`Customer ID: ${safe(inv.customer_code)}`, 300, z2Y+62, { width: 250 })

    doc.moveDown(6)

    // ---------- Zone 3: Vehicle Details ----------
    const z3Y = doc.y
    doc.roundedRect(36, z3Y, 524, 56, 6).stroke()
    doc.fontSize(10)
    doc.text(`Category: ${safe(inv.vehicle_type,'—')}`, 44, z3Y+8, { width: 250 })
    doc.text(`Tyres: ${safe(inv.tyre_count)}`, 300, z3Y+8, { width: 250 })
    const tyreSize = [safe(inv.tyre_width_mm,'-'), safe(inv.aspect_ratio,'-'), safe(inv.rim_diameter_in,'-')].join(' / ').replace(' / -','').replace('/ -','')
    doc.text(`Tyre Size: ${tyreSize}`, 44, z3Y+26, { width: 250 })
    const installed = safe(inv.fitment_locations,'') || `${safe(inv.tyre_count)}` // fallback: show count
    doc.text(`Installed Tyres: ${installed}`, 300, z3Y+26, { width: 250 })

    doc.moveDown(5)

    // ---------- Zone 4: Fitment & Tread Depth ----------
    const z4Y = doc.y
    doc.roundedRect(36, z4Y, 524, 70, 6).stroke()
    doc.fontSize(10).text('Fitment & Tread Depth (mm)', 44, z4Y+6)
    // Simple 2x2 grid labels (FL/FR/RL/RR) using whatever fields are available
    const rowY1 = z4Y + 24
    const rowY2 = z4Y + 42
    doc.text(`Front Left: ${safe(inv.tread_fl_mm)}`, 44, rowY1, { width: 250 })
    doc.text(`Front Right: ${safe(inv.tread_fr_mm)}`, 300, rowY1, { width: 250 })
    doc.text(`Rear Left: ${safe(inv.tread_rl_mm)}`, 44, rowY2, { width: 250 })
    doc.text(`Rear Right: ${safe(inv.tread_rr_mm)}`, 300, rowY2, { width: 250 })
    // dosage summary (if present)
    const perTyre = inv.tyre_count ? Math.round((Number(inv.dosage_ml||0) / Number(inv.tyre_count))*10)/10 : null
    doc.text(`Per-tyre Dosage: ${perTyre ? perTyre+' ml' : '—'}`, 44, z4Y+58)
    doc.text(`Total Dosage: ${safe(inv.dosage_ml)} ml`, 300, z4Y+58)

    doc.moveDown(5.5)

    // ---------- Zone 5: Pricing (aligned table) ----------
    const z5Y = doc.y
    doc.roundedRect(36, z5Y, 524, 130, 6).stroke()
    doc.fontSize(10)
    // left column
    const Lx = 44, Rx = 340, Vy = (y, k, v) => { doc.text(k, Lx, y); doc.text(v, Rx, y, { width: 210, align:'right' }) }
    const mrp = inv.price_per_ml ?? 4.5
    Vy(z5Y+10, 'Total Dosage (ml)', safe(inv.dosage_ml,'—'))
    Vy(z5Y+26, 'MRP per ml', inr(mrp, 2))
    Vy(z5Y+42, 'Gross', inr(inv.total_before_gst || (Number(inv.dosage_ml||0)*Number(mrp||0))))
    // optional discount & installation charges (only render if present)
    if (inv.discount_amount != null) Vy(z5Y+58, 'Discount', `- ${inr(inv.discount_amount)}`)
    if (inv.installation_charges != null) Vy(z5Y+74, 'Installation Charges', inr(inv.installation_charges))
    const taxMode = inv.tax_mode || 'CGST+SGST'
    Vy(z5Y+90, 'Tax Mode', taxMode)
    const gstRate = inv.gst_rate || 18
    const half = gstRate/2
    if (taxMode.toUpperCase().includes('IGST')) {
      Vy(z5Y+106, `IGST (${gstRate}%)`, inr(inv.gst_amount ?? 0))
    } else {
      Vy(z5Y+106, `CGST (${half}%)`, inr((inv.gst_amount ?? 0)/2))
      Vy(z5Y+122, `SGST (${half}%)`, inr((inv.gst_amount ?? 0)/2))
    }
    // right column footer lines (Amount before GST, GST Total, Total with GST)
    const AYG = z5Y + 148
    doc.moveTo(36, z5Y+150).lineTo(560, z5Y+150).stroke()
    const lbl = (t, y)=> doc.text(t, 44, y)
    const val = (t, y)=> doc.text(t, 340, y, { width: 210, align: 'right' })
    lbl('Amount (before GST)', z5Y+156);   val(inr(inv.total_before_gst ?? 0), z5Y+156)
    lbl('GST Total', z5Y+172);             val(inr(inv.gst_amount ?? 0), z5Y+172)
    lbl('Total (with GST)', z5Y+188);      val(inr(inv.total_with_gst ?? 0), z5Y+188)

    doc.moveDown(9)

    // ---------- Declaration & Terms (compact) ----------
    doc.fontSize(9).text('Customer Declaration', { underline:true })
    doc.text('1) I hereby acknowledge that the MaxTT Tyre Sealant installation has been completed on my vehicle to my satisfaction, as per my earlier consent to proceed.')
    doc.text('2) I have read, understood, and accepted the Terms & Conditions stated herein.')
    doc.text('3) I acknowledge that the total amount shown is correct and payable to the franchisee/installer of Treadstone Solutions.')
    doc.moveDown(0.4)
    doc.fontSize(9).text('Terms & Conditions', { underline:true })
    doc.text('1) MaxTT Tyre Sealant is a preventive safety solution; effectiveness depends on adherence to driving norms and vehicle condition.')
    doc.text('2) Effectiveness assured only within lawful speed limits as prescribed by competent authorities.')
    doc.text('3) Jurisdiction: Gurgaon.')

    doc.moveDown(1)

    // ---------- Signatures ----------
    const y = doc.y
    doc.rect(36, y, 240, 58).stroke(); doc.text('Installer Signature & Stamp', 44, y+42)
    doc.rect(320, y, 240, 58).stroke(); doc.text('Customer Accepted & Confirmed', 328, y+42)
    doc.text(`Signed at: ${when} IST`, 36, y+70)

    doc.end()
  }catch(e){
    res.status(500).json({ error:'pdf_failed', message: e?.message || String(e) })
  }finally{
    client.release()
  }
})

// ---------------------- Franchisee Onboarding APIs (minimal) -----------
function makeFrId(stateCode, cityCode, n){
  const sc=String(stateCode||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,2)
  const cc=String(cityCode||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,3)
  const num=String(Number(n)||1).padStart(3,'0')
  return `TS-${sc}-${cc}-${num}`
}
app.post('/api/super/franchisees/approve/:id', requireSA, async (req,res)=>{
  const client=await pool.connect()
  try{
    const id=Number(req.params.id||0)
    if (!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'bad_id' })
    const note=(req.body?.note||'').trim()
    const approver=(req.get('X-SA-USER')||'superadmin').trim()||'superadmin'
    const nowIso=new Date().toISOString()
    const r=await client.query(`
      UPDATE public.franchisees
      SET status='ACTIVE', approval_by=$2, approval_at=$3, approval_note=$4, rejection_reason=NULL
      WHERE id=$1 RETURNING *`,[id,approver,nowIso,note])
    res.json({ ok:true, franchisee:r.rows[0] })
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) })
  }finally{ client.release() }
})
app.post('/api/super/franchisees/reject/:id', requireSA, async (req,res)=>{
  const client=await pool.connect()
  try{
    const id=Number(req.params.id||0)
    if (!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'bad_id' })
    const reason=(req.body?.reason||'').trim()
    if (!reason) return res.status(400).json({ ok:false, error:'missing_reason' })
    const approver=(req.get('X-SA-USER')||'superadmin').trim()||'superadmin'
    const nowIso=new Date().toISOString()
    const r=await client.query(`
      UPDATE public.franchisees
      SET status='REJECTED', approval_by=$2, approval_at=$3, rejection_reason=$4, approval_note=NULL
      WHERE id=$1 RETURNING *`,[id,approver,nowIso,reason])
    res.json({ ok:true, franchisee:r.rows[0] })
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) })
  }finally{ client.release() }
})

// ------------------------------- 404 -----------------------------------
app.use((_req,res)=>res.status(404).json({ error:'not_found' }))

// ------------------------------ Start ----------------------------------
const port=Number(process.env.PORT||10000)
app.listen(port, ()=>console.log(`Billing API listening on :${port}`))
