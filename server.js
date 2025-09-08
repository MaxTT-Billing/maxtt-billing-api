// server.js — MaxTT Billing API (ESM) — with PDF invoices
// Keep env: ALLOWED_ORIGINS, DATABASE_URL, SUPER_ADMIN_KEY, ADMIN_KEY, etc.

import express from 'express'
import pkg from 'pg'
const { Pool } = pkg
import { fileURLToPath } from 'url'
import path from 'path'
import PDFDocument from 'pdfkit'            // <-- NEW: for /api/invoices/:id/pdf

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

// --------------------------- Helpers (invoices) ------------------------
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

// ---------------------- Invoices: create (basic) -----------------------
// (Kept minimal as per current UAT; front-end POSTs here.)
app.post('/api/invoices/full', async (req,res)=>{
  const client = await pool.connect()
  try{
    const body = req.body || {}
    const franchisee_id = String(body.franchisee_id || body.franchiseeId || '').trim()
    const tyre_width_mm = Number(body.tyre_width_mm || 195)
    const rim_diameter_in = Number(body.rim_diameter_in || 15)
    const tyre_count = Number(body.tyre_count || 4)

    if (!franchisee_id) return res.status(400).json({ ok:false, error:'missing_franchisee_id' })

    // dosage & pricing (defaults via env)
    const DEFAULT_QTY_ML = Number(process.env.DEFAULT_QTY_ML || 1200)
    const MRP_PER_ML = Number(process.env.MRP_PER_ML || process.env.FALLBACK_MRP_PER_ML || 4.5)
    const total_before_gst = Math.round(DEFAULT_QTY_ML * MRP_PER_ML) // 1200 * 4.5 = 5400
    const gst_amount = Math.round(total_before_gst * 0.18)           // 972
    const total_with_gst = total_before_gst + gst_amount             // 6372

    // normalized invoice number: FRANCHISEE-#### (#### = padded sequence)
    // We derive next seq by counting existing rows for same franchisee_id.
    const cols = await getInvoiceCols(client)
    const fcol = findCol(cols,['franchisee_id','franchisee_code']) || 'franchisee_id'
    const idCol = findCol(cols,['id','invoice_id']) || 'id'
    const seqQ = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.invoices WHERE ${qid(fcol)}=$1`, [franchisee_id]
    )
    const seq = (seqQ.rows?.[0]?.c || 0) + 1
    const seqStr = pad(seq,4)
    const invoice_number_norm = `${franchisee_id}-${seqStr}`

    // printed invoice number: add /MMYY/seq
    const now = new Date()
    const mm = String(now.getUTCMonth() + 1).padStart(2,'0')
    const yy = String(now.getUTCFullYear()).slice(-2)
    const invoice_number = `${franchisee_id}/${mm}${yy}/${seqStr}`

    const r = await client.query(`
      INSERT INTO public.invoices
      (${qid(fcol)},"invoice_number_norm","invoice_number","tyre_count","tyre_width_mm","rim_diameter_in",
       "dosage_ml","price_per_ml","total_before_gst","gst_amount","total_with_gst","created_at")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
      RETURNING ${qid(idCol)} AS id, "customer_code","invoice_number_norm","invoice_number"
    `,[
      franchisee_id, invoice_number_norm, invoice_number, tyre_count, tyre_width_mm, rim_diameter_in,
      DEFAULT_QTY_ML, MRP_PER_ML, total_before_gst, gst_amount, total_with_gst
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
    const idCol=findCol(cols,['id','invoice_id']) || 'id'
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
// latest
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
// get full2
app.get(['/api/invoices/:id/full2','/invoices/:id/full2'], async (req,res)=>{
  const client=await pool.connect()
  try{
    const id=Number(req.params.id||0)
    if (!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'bad_id' })
    const cols=await getInvoiceCols(client)
    const idCol=findCol(cols,['id','invoice_id']) || 'id'
    const r=await client.query(`SELECT * FROM public.invoices WHERE ${qid(idCol)}=$1 LIMIT 1`,[id])
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.setHeader('Cache-Control','no-store')
    res.json(r.rows[0])
  }catch(err){
    res.status(500).json({ ok:false, where:'get_invoice_full2', message: err?.message || String(err) })
  }finally{ client.release() }
})
// by norm
app.get('/api/invoices/by-norm/:norm', async (req,res)=>{
  const client=await pool.connect()
  try{
    const norm=String(req.params.norm||'').trim()
    if(!norm) return res.status(400).json({ ok:false, error:'missing_norm' })
    const cols=await getInvoiceCols(client)
    if(!has(cols,'invoice_number_norm')) return res.status(400).json({ ok:false, error:'column_missing: invoice_number_norm' })
    const r=await client.query(`SELECT * FROM public.invoices WHERE "invoice_number_norm"=$1 LIMIT 1`,[norm])
    if(!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' })
    res.json(r.rows[0])
  }catch(err){
    res.status(500).json({ ok:false, where:'by_norm', message: err?.message || err })
  }finally{ client.release() }
})

// ------------------------------- PDF Invoice ----------------------------
// Generates a simple branded PDF (Treadstone watermark)
function toINR(n){
  if (n == null) return '-'
  const v = Number(n)
  if (!isFinite(v)) return String(n)
  return v.toLocaleString('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:0 })
}
app.get('/api/invoices/:id/pdf', async (req,res)=>{
  const id = Number(req.params.id || 0)
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error:'bad_id' })

  const client = await pool.connect()
  try{
    const r = await client.query(`SELECT * FROM public.invoices WHERE id=$1 LIMIT 1`, [id])
    if (!r.rows.length) return res.status(404).json({ error:'not_found' })
    const inv = r.rows[0]

    // prefer persisted printed #; fallback to norm
    const printed = inv.invoice_number || inv.invoice_number_norm || `INV-${id}`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${printed}.pdf"`)

    const doc = new PDFDocument({ size:'A4', margin:40 })
    doc.pipe(res)

    // Header
    doc.fontSize(18).text('TREADSTONE SOLUTIONS', { align:'left' })
      .moveDown(0.3)
      .fontSize(10).text('MaxTT — Tyre Life Extension', { align:'left' })
      .moveDown(0.8)

    // Invoice info
    doc.fontSize(12)
      .text(`Invoice #: ${printed}`)
      .text(`Date: ${new Date().toLocaleDateString('en-IN')}`)
      .text(`Franchisee: ${inv.franchisee_id || inv.franchisee_code || '-'}`)
      .moveDown(0.5)

    // Customer / job
    doc.fontSize(11)
      .text(`Customer Code: ${inv.customer_code || '-'}`)
      .text(`Vehicle: ${inv.vehicle_number || '-'}`)
      .text(`Tyres: ${inv.tyre_count ?? '-'}`)
      .moveDown(0.5)

    const subtotal = Number(inv.total_before_gst ?? 0)
    const gst = Number(inv.gst_amount ?? 0)
    const total = Number(inv.total_with_gst ?? 0)

    doc.fontSize(12)
      .text(`Subtotal: ${toINR(subtotal)}`)
      .text(`GST (18%): ${toINR(gst)}`)
      .text(`Total: ${toINR(total)}`)
      .moveDown(1)

    // Signature boxes
    const y = doc.y
    doc.rect(40, y, 220, 60).stroke(); doc.text('Customer Signature', 50, y + 45)
    doc.rect(320, y, 220, 60).stroke(); doc.text('Installer Signature', 330, y + 45)

    // Watermark
    doc.rotate(-30, { origin:[300, 500] })
       .fontSize(60).fillColor('#EEEEEE').text('TREADSTONE', 80, 450, { opacity:0.3 })
       .fillColor('#000000').rotate(30, { origin:[300,500] })

    doc.end()
  }catch(e){
    res.status(500).json({ error:'pdf_failed', message: e?.message || String(e) })
  }finally{
    client.release()
  }
})

// ---------------------- Franchisee Onboarding APIs ---------------------
// (Kept as in your current file; approve/reject endpoints retained.)
function makeFrId(stateCode, cityCode, n){
  const sc=String(stateCode||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,2)
  const cc=String(cityCode||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,3)
  const num=String(Number(n)||1).padStart(3,'0')
  return `TS-${sc}-${cc}-${num}`
}

// SA: install (self-healing)
app.post('/api/admin/franchisees/install', requireSA, async (_req, res) => {
  const client = await pool.connect()
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.franchisees(
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE,
      email TEXT UNIQUE,
      phone TEXT,
      status TEXT DEFAULT 'PENDING_APPROVAL',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      approval_by TEXT,
      approval_at TIMESTAMPTZ,
      approval_note TEXT,
      rejection_reason TEXT
    )`)
    res.json({ ok:true, installed:true })
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message||e) })
  } finally { client.release() }
})

// SA: approve
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

// SA: reject
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
