// server.js — MaxTT / Treadstone Solutions Billing API (ESM)
// v3: PDF matches 5-zone layout like invoice #46; Zone-2 adds HSN Code + Customer ID.
// No logo, no PDF watermark (prints on pre-watermarked sheets).

import express from 'express'
import pkg from 'pg'
const { Pool } = pkg
import { fileURLToPath } from 'url'
import path from 'path'
import PDFDocument from 'pdfkit'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()

// ------------------------------- CORS ---------------------------------
const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://maxtt-billing-frontend.onrender.com,https://maxtt-billing-tools.onrender.com')
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
function fmtIST(iso){
  const d = iso ? new Date(iso) : new Date()
  // DD/MM/YYYY, HH:mm IST
  const dd = String(d.getUTCDate()).padStart(2,'0')
  const mm = String(d.getUTCMonth()+1).padStart(2,'0')
  const yy = String(d.getUTCFullYear())
  const hh = String(d.getUTCHours()).padStart(2,'0')
  const mi = String(d.getUTCMinutes()).padStart(2,'0')
  // Convert UTC parts to IST quickly by constructing in UTC then shifting:
  const ist = new Date(d.getTime() + 5.5*60*60*1000)
  const dd2 = String(ist.getUTCDate()).padStart(2,'0')
  const mm2 = String(ist.getUTCMonth()+1).padStart(2,'0')
  const yy2 = String(ist.getUTCFullYear())
  const hh2 = String(ist.getUTCHours()).padStart(2,'0')
  const mi2 = String(ist.getUTCMinutes()).padStart(2,'0')
  return `${dd2}/${mm2}/${yy2}, ${hh2}:${mi2} IST`
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
function tyreSizeFmt(w,a,r){
  const W = safe(w,'-'), A = safe(a,'-'), R = safe(r,'-')
  if (W==='-' && R==='-') return '—'
  if (A==='-') return `${W}/ R${R}`.replace('//','/').replace('  ',' ')
  return `${W}/${A} R${R}`.replace('  ',' ')
}

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

// ------------------------------- PDF (5 zones) -------------------------
// Layout mirrors your invoice #46; titles/order; no logo/watermark.
// Zone-2 includes HSN Code + Customer ID at the bottom (your request).
app.get('/api/invoices/:id/pdf', async (req,res)=>{
  const id = Number(req.params.id || 0)
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error:'bad_id' })
  const download = String(req.query.download||'').trim() === '1'

  const client = await pool.connect()
  try{
    const ir = await client.query(`SELECT * FROM public.invoices WHERE id=$1 LIMIT 1`, [id])
    if (!ir.rows.length) return res.status(404).json({ error:'not_found' })
    const inv = ir.rows[0]

    const frCode = inv.franchisee_id || inv.franchisee_code || ''
    let fr = null
    if (frCode) {
      const frq = await client.query(`SELECT * FROM public.franchisees WHERE code=$1 LIMIT 1`, [frCode])
      fr = frq.rows[0] || null
    }

    const printed = inv.invoice_number || printedFromNorm(inv.invoice_number_norm) || `INV-${id}`
    const when = fmtIST(inv.created_at)
    const cdisp = download ? 'attachment' : 'inline'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `${cdisp}; filename="${printed}.pdf"`)

    const doc = new PDFDocument({ size:'A4', margin:36 })
    doc.pipe(res)

    // ---------- Header (two-column) ----------
    // Left: Franchisee block
    doc.fontSize(12).text(safe(fr?.legal_name, 'Franchisee'), { width: 320 })
    doc.moveDown(0.1)
    const addr = [fr?.address1, fr?.address2].filter(Boolean).join(', ')
    doc.fontSize(9).text(safe(addr,'Address not set'), { width: 320 })
    doc.text(`Franchisee ID: ${safe(frCode)}`, { width: 320 })
    const gstin = safe(fr?.gstin, '')
    if (gstin !== '—') doc.text(`GSTIN: ${gstin}`, { width: 320 })

    // Right: Invoice meta box (single-line no wrap)
    const rightX = 365, metaW = 190, topY = 36
    doc.roundedRect(rightX, topY, metaW, 60, 6).stroke()
    doc.fontSize(10)
    doc.text(`Invoice No: ${printed}`, rightX+8, topY+8, { width: metaW-16, height:14 })
    doc.text(`Date: ${when}`,           rightX+8, topY+28, { width: metaW-16, height:14 })

    doc.moveDown(0.6)

    // ---------- Zone 2: Customer Details (with HSN + Customer ID) ----------
    const z2Y = doc.y
    doc.roundedRect(36, z2Y, 520, 92, 6).stroke()
    doc.fontSize(10).text('Customer Details', 44, z2Y+6)
    doc.fontSize(10)
    doc.text(`Name: ${safe(inv.customer_name)}`, 44, z2Y+22, { width: 250 })
    doc.text(`Mobile: ${safe(inv.mobile_number)}`, 300, z2Y+22, { width: 240 })
    doc.text(`Vehicle: ${safe(inv.vehicle_number)}`, 44, z2Y+38, { width: 250 })
    doc.text(`Odometer Reading: ${safe(inv.odometer)} km`, 300, z2Y+38, { width: 240 })
    doc.text(`Customer GSTIN: ${safe(inv.customer_gstin)}`, 44, z2Y+54, { width: 250 })
    doc.text(`Address: ${safe(inv.customer_address)}`, 300, z2Y+54, { width: 240 })
    doc.text(`Installer: ${safe(inv.installer_name)}`, 44, z2Y+70, { width: 250 })
    // Additions (bottom row)
    const hsn = inv.hsn_code || '35069999'
    doc.text(`HSN Code: ${hsn}`, 300, z2Y+70, { width: 240 })

    // Second line for Customer ID (under Installer/HSN)
    doc.text(`Customer ID: ${safe(inv.customer_code)}`, 44, z2Y+86, { width: 250 })

    doc.moveDown(7)

    // ---------- Zone 3: Vehicle Details ----------
    const z3Y = doc.y
    doc.roundedRect(36, z3Y, 520, 58, 6).stroke()
    doc.fontSize(10).text('Vehicle Details', 44, z3Y+6)
    doc.fontSize(10)
    doc.text(`Category: ${safe(inv.vehicle_type,'—')}`, 44, z3Y+22, { width: 250 })
    doc.text(`Tyres: ${safe(inv.tyre_count)}`, 300, z3Y+22, { width: 240 })
    const tyreSize = tyreSizeFmt(inv.tyre_width_mm, inv.aspect_ratio, inv.rim_diameter_in)
    doc.text(`Tyre Size: ${tyreSize}`, 44, z3Y+38, { width: 250 })
    const installed = safe(inv.fitment_locations,'') || `${safe(inv.tyre_count)}`
    doc.text(`Installed Tyres: ${installed}`, 300, z3Y+38, { width: 240 })

    doc.moveDown(6)

    // ---------- Zone 4: Fitment & Tread Depth ----------
    const z4Y = doc.y
    doc.roundedRect(36, z4Y, 520, 70, 6).stroke()
    doc.fontSize(10).text('Fitment & Tread Depth (mm)', 44, z4Y+6)
    const rowY1 = z4Y + 24
    const rowY2 = z4Y + 42
    doc.text(`Front Left: ${safe(inv.tread_fl_mm)}`, 44, rowY1, { width: 240 })
    doc.text(`Front Right: ${safe(inv.tread_fr_mm)}`, 300, rowY1, { width: 240 })
    doc.text(`Rear Left: ${safe(inv.tread_rl_mm)}`, 44, rowY2, { width: 240 })
    doc.text(`Rear Right: ${safe(inv.tread_rr_mm)}`, 300, rowY2, { width: 240 })
    // dosage summary
    const perTyre = inv.tyre_count ? Math.round((Number(inv.dosage_ml||0) / Number(inv.tyre_count))*10)/10 : null
    doc.text(`Per-tyre Dosage: ${perTyre ? perTyre+' ml' : '—'}`, 44, z4Y+58)
    doc.text(`Total Dosage: ${safe(inv.dosage_ml)} ml`, 300, z4Y+58)

    doc.moveDown(6)

    // ---------- Zone 5: Pricing (Description / Value list) ----------
    const z5Y = doc.y
    doc.roundedRect(36, z5Y, 520, 156, 6).stroke()
    doc.fontSize(10).text('Description', 44, z5Y+6)
    doc.text('Value', 340, z5Y+6, { width: 200, align: 'right' })
    const Lx = 44, Rx = 340, V = (y, k, v) => { doc.text(k, Lx, y); doc.text(v, Rx, y, { width: 200, align:'right' }) }
    const mrp = inv.price_per_ml ?? 4.5
    V(z5Y+22, 'Total Dosage (ml)', safe(inv.dosage_ml,'—'))
    V(z5Y+38, 'MRP per ml', inr(mrp, 2))
    V(z5Y+54, 'Gross', inr(inv.total_before_gst || (Number(inv.dosage_ml||0)*Number(mrp||0))))
    if (inv.discount_amount != null)      V(z5Y+70, 'Discount', `- ${inr(inv.discount_amount)}`)
    if (inv.installation_charges != null) V(z5Y+86, 'Installation Charges', inr(inv.installation_charges))
    V(z5Y+102, 'Tax Mode', safe(inv.tax_mode || 'CGST+SGST'))
    const gstRate = Number(inv.gst_rate ?? 18)
    const half = gstRate/2
    // Always display CGST, SGST, IGST rows (IGST=0 under CGST+SGST)
    const isIGST = String(inv.tax_mode||'').toUpperCase().includes('IGST')
    if (isIGST) {
      V(z5Y+118, `IGST (${gstRate}%)`, inr(inv.gst_amount ?? 0))
      V(z5Y+134, `CGST (${half}%)`, inr(0))
      V(z5Y+150, `SGST (${half}%)`, inr(0))
    } else {
      const halfAmt = (Number(inv.gst_amount ?? 0) / 2)
      V(z5Y+118, `CGST (${half}%)`, inr(halfAmt))
      V(z5Y+134, `SGST (${half}%)`, inr(halfAmt))
      V(z5Y+150, `IGST (${gstRate}%)`, inr(0))
    }

    // Totals separator + three lines
    doc.moveTo(36, z5Y+172).lineTo(556, z5Y+172).stroke()
    const TL = (t,y)=> doc.text(t, 44, y)
    const TV = (t,y)=> doc.text(t, 340, y, { width:200, align:'right' })
    TL('Amount (before GST)', z5Y+178); TV(inr(inv.total_before_gst ?? 0), z5Y+178)
    TL('GST Total', z5Y+194);          TV(inr(inv.gst_amount ?? 0), z5Y+194)
    TL('Total (with GST)', z5Y+210);   TV(inr(inv.total_with_gst ?? 0), z5Y+210)

    doc.moveDown(9)

    // ---------- Declarations & Terms (as #46 tone) ----------
    doc.fontSize(9).text('Customer Declaration', { underline:true })
    doc.text('1. I hereby acknowledge that the MaxTT Tyre Sealant installation has been completed on my vehicle to my satisfaction, as per my earlier consent to proceed.')
    doc.text('2. I have read, understood, and accepted the Terms & Conditions stated herein.')
    doc.text('3. I acknowledge that the total amount shown is correct and payable to the franchisee/installer of Treadstone Solutions.')
    doc.moveDown(0.4)
    doc.text('Terms & Conditions', { underline:true })
    doc.text('1. The MaxTT Tyre Sealant is a preventive safety solution designed to reduce tyre-related risks and virtually eliminate punctures and blowouts.')
    doc.text('2. Effectiveness is assured only when the vehicle is operated within the speed limits prescribed by competent traffic/transport authorities (RTO/Transport Department) in India.')
    doc.text('3. Jurisdiction: Gurgaon.')

    doc.moveDown(1)

    // ---------- Signatures ----------
    const y = doc.y
    doc.rect(36, y, 240, 58).stroke(); doc.text('Installer Signature & Stamp', 44, y+42)
    doc.rect(320, y, 240, 58).stroke(); doc.text('Customer Accepted & Confirmed', 328, y+42)
    doc.text(`Signed at: ${when}`, 36, y+70)

    doc.end()
  }catch(e){
    res.status(500).json({ error:'pdf_failed', message: e?.message || String(e) })
  }finally{
    client.release()
  }
})

// ---------------------- Franchisee Onboarding APIs (minimal) -----------
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
