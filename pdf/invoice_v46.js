// pdf/invoice_v46.js — v46 single-page layout (FINAL: hanging indents for Z4/Z5)
//
// Final tweaks:
// • Zone 4 & Zone 5 numbered paragraphs now render with a hanging indent so
//   continuation lines align flush under the first word (after "1. ", "2. ", "3. ").
// • Uniform gaps between points. Zones 1–3 unchanged from your accepted version.

import PDFDocument from 'pdfkit'

const safe = (v, alt='—') => (v === null || v === undefined || String(v).trim()==='') ? alt : String(v)
const inr = (n, d=2) => 'Rs. ' + Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:d,maximumFractionDigits:d})
const tyreSizeFmt = (w,a,r)=>{
  const W = safe(w,'-'), A = safe(a,'-'), R = safe(r,'-')
  if (W==='-' && R==='-') return '—'
  if (A==='-' || A==='—') return `${W} R${R}`.replace('  ',' ')
  return `${W}/${A} R${R}`.replace('  ',' ')
}
const fmtIST = (iso)=>{
  const d = iso ? new Date(iso) : new Date()
  const ist = new Date(d.getTime() + 5.5*60*60*1000)
  const dd = String(ist.getUTCDate()).padStart(2,'0')
  const mm = String(ist.getUTCMonth()+1).padStart(2,'0')
  const yy = String(ist.getUTCFullYear())
  const hh = String(ist.getUTCHours()).padStart(2,'0')
  const mi = String(ist.getUTCMinutes()).padStart(2,'0')
  return `${dd}/${mm}/${yy}, ${hh}:${mi} IST`
}
const printedFromNorm = (norm, id) => {
  if (!norm) return `INV-${id}`
  const m = String(norm).match(/^(.*)-(\d{4})$/)
  if (!m) return `INV-${id}`
  const seq = m[2]
  const d = new Date(); const mm = String(d.getUTCMonth()+1).padStart(2,'0'); const yy = String(d.getUTCFullYear()).slice(-2)
  return `${m[1]}/${mm}${yy}/${seq}`
}

// Render a numbered paragraph with hanging indent:
// - prefix like "1. " drawn at (x,y)
// - body drawn at (x + prefixWidth, y) with width reduced accordingly
// - returns new y after paragraph with uniform gap
function bulletPara(doc, {x, y, width, number, text, font='Helvetica', size=9, align='justify', gap=10}) {
  const prefix = `${number}. `
  doc.font(font).fontSize(size)
  const pw = doc.widthOfString(prefix) // measure width of "n. "
  // draw prefix
  doc.text(prefix, x, y, { width: pw, continued: false })
  // draw body with hanging indent
  const bodyW = Math.max(10, width - pw)
  const h = doc.heightOfString(text, { width: bodyW, align })
  doc.text(text, x + pw, y, { width: bodyW, align })
  return y + h + gap
}

export async function createV46Pdf(stream, inv, fr) {
  return new Promise((resolve,reject)=>{
    const doc = new PDFDocument({ size:'A4', margin:36 })
    doc.pipe(stream)

    // ---- Grid / constants ----
    const pageLeft = 36, pageRight = 556
    const Lx = 44, Lw = 250               // left column anchor (Zones 1–3 & para left)
    const Rx = 292, RkW = 150             // right keys anchor/width
    const RxVal = 430                     // unified VALUE column X for Z2 & Z3
    const RvW = pageRight - RxVal         // width for right values
    const rowGap = 14
    const thin = 0.5
    const HLine = (y)=> { doc.moveTo(pageLeft, y).lineTo(pageRight, y).lineWidth(thin).stroke() }

    // ===== ZONE 1: Header (final) =====
    const frName  = safe(fr?.legal_name,'Franchisee')
    const frAddr  = safe([fr?.address1, fr?.address2].filter(Boolean).join(', '), 'Address not set')
    const frCode  = safe(inv.franchisee_id || inv.franchisee_code)
    const frGstin = safe(fr?.gstin, '—')
    const frPhone = safe(fr?.phone, '—')
    const frEmail = safe(fr?.email, '—')
    const printed = inv.invoice_number || printedFromNorm(inv.invoice_number_norm, inv.id)

    let y = 36
    doc.font('Helvetica-Bold').fontSize(12).text(frName, Lx, y, { width: 322 })
    doc.font('Helvetica-Bold').fontSize(10).text(`Invoice No: ${printed}`, 352, y+4, { width: 204 })
    y += rowGap + 4

    doc.font('Helvetica').fontSize(9).text(frAddr, Lx, y, { width: 322 })
    doc.font('Helvetica').fontSize(10).text(`Date: ${fmtIST(inv.created_at)}`, 352, y, { width: 204 })
    y += rowGap

    doc.font('Helvetica').fontSize(9).text(`Franchisee ID: ${frCode}`, Lx, y, { width: 322 }); y += rowGap
    doc.font('Helvetica').fontSize(9).text(`GSTIN: ${frGstin}`, Lx, y, { width: 322 });        y += rowGap
    doc.font('Helvetica').fontSize(9).text(`Contact: ${frPhone}  |  Email: ${frEmail}`, Lx, y, { width: 322 })
    y += rowGap - 2
    HLine(y)

    // ===== ZONE 2: Customer & Vehicle (final) =====
    y += 8
    doc.font('Helvetica-Bold').fontSize(10).text('Customer Details', Lx, y)
    doc.font('Helvetica-Bold').fontSize(10).text('Vehicle Details',  Rx, y)
    y += rowGap

    // LEFT (Customer)
    doc.font('Helvetica').fontSize(10)
    const custId = safe(inv.invoice_number_norm)
    const leftRows = [
      ['Name',               safe(inv.customer_name)],
      ['Address',            safe(inv.customer_address)],
      ['Contact Number',     safe(inv.mobile_number)],
      ['Customer GSTIN',     safe(inv.customer_gstin)],
      ['Vehicle Number',     safe(inv.vehicle_number)],
      ['Odometer reading',   safe(inv.odometer) === '—' ? '—' : `${safe(inv.odometer)} km`],
      ['Customer ID',        custId],
      ['Installer name',     safe(inv.installer_name)],
      ['HSN CODE',           inv.hsn_code || '35069999'],
    ]
    let ly = y
    for (const [k,v] of leftRows){
      doc.text(`${k}: ${v}`, Lx, ly, { width: Lw })
      ly += rowGap
    }

    // RIGHT (Vehicle)
    const tyreSize = tyreSizeFmt(inv.tyre_width_mm, inv.aspect_ratio, inv.rim_diameter_in)
    const installed = safe(inv.fitment_locations,'') || `${safe(inv.tyre_count)}`
    let ry = y
    const rightFirst4 = [
      ['Category',           safe(inv.vehicle_type,'4-Wheeler (Car/Van/SUV)')],
      ['Tyres',              safe(inv.tyre_count)],
      ['Installed In Tyres', installed],
      ['Tyre Size',          tyreSize],
    ]
    doc.font('Helvetica').fontSize(10)
    for (const [k,v] of rightFirst4){
      doc.text(`${k}:`, Rx, ry, { width: RkW })
      doc.text(String(v), RxVal, ry, { width: RvW, align: 'left' })
      ry += rowGap
    }
    // Subheading + headers (bold)
    doc.font('Helvetica-Bold').fontSize(10).text('Fitment & Tread Depth (mm)', Rx, ry); ry += rowGap
    doc.font('Helvetica-Bold').fontSize(9).text('Position',  Rx,    ry)
    doc.font('Helvetica-Bold').fontSize(9).text('Tread (mm)', RxVal, ry, { width: 80, align:'left' })
    ry += rowGap
    // Tread rows
    doc.font('Helvetica').fontSize(10)
    const treadRows = [
      ['Front Left',  safe(inv.tread_fl_mm)],
      ['Front Right', safe(inv.tread_fr_mm)],
      ['Rear Left',   safe(inv.tread_rl_mm)],
      ['Rear Right',  safe(inv.tread_rr_mm)],
    ]
    for (const [pos, val] of treadRows){
      doc.text(pos, Rx, ry, { width: RkW })
      doc.text(val, RxVal, ry, { width: 80, align:'left' })
      ry += rowGap
    }
    const perTyre = inv.tyre_count ? Math.round((Number(inv.dosage_ml||0) / Number(inv.tyre_count))*10)/10 : null
    doc.text('Per-tyre Dosage:', Rx, ry, { width: RkW }); doc.text(perTyre ? `${perTyre} ml` : '—', RxVal, ry, { width: 80, align:'left' }); ry += rowGap
    doc.text('Total Dosage:',    Rx, ry, { width: RkW }); doc.text(`${safe(inv.dosage_ml)} ml`,      RxVal, ry, { width: 80, align:'left' }); ry += rowGap

    const z2Bottom = Math.max(ly, ry) + 6
    HLine(z2Bottom)

    // ===== ZONE 3: Pricing (final; heading + values at RxVal) =====
    let py = z2Bottom + 8
    doc.font('Helvetica-Bold').fontSize(10).text('Description/Particulars', Lx, py)
    doc.font('Helvetica-Bold').fontSize(10).text('Value', RxVal, py)  // aligned to value column
    py += rowGap

    const V = (label, value) => {
      doc.font('Helvetica').fontSize(10).text(label, Lx, py)
      doc.font('Helvetica').fontSize(10).text(String(value), RxVal, py, { width: RvW, align:'left' })
      py += rowGap
    }
    const mrp = inv.price_per_ml ?? 4.5
    const gross = inv.total_before_gst ?? (Number(inv.dosage_ml||0) * Number(mrp||0))
    const gstRate = Number(inv.gst_rate ?? 18)
    const isIGST = String(inv.tax_mode||'').toUpperCase().includes('IGST')
    const gstTotal = Number(inv.gst_amount ?? Math.round(gross * gstRate/100))
    const halfRate = gstRate/2
    const cgst = isIGST ? 0 : gstTotal/2
    const sgst = isIGST ? 0 : gstTotal/2
    const igst = isIGST ? gstTotal : 0
    const grand = inv.total_with_gst ?? (gross + gstTotal)

    V('Total Dosage (ml)', safe(inv.dosage_ml,'—'))
    V('MRP/ml', inr(mrp,2))
    V('Gross Total', inr(gross))
    if (inv.installation_charges != null) V('Installation Charges', inr(inv.installation_charges))
    if (inv.discount_amount != null)      V('Discount', `- ${inr(inv.discount_amount)}`)
    V('Tax Mode', isIGST ? 'IGST' : 'CGST+SGST')
    V(`CGST (${halfRate}%)`, inr(cgst))
    V(`SGST (${halfRate}%)`, inr(sgst))
    V(`IGST (${gstRate}%)`,  inr(igst))
    V('Amount (Before GST)', inr(gross))
    V('Total GST',           inr(gstTotal))
    V('Grand Total (with GST)', inr(grand))

    HLine(py + 2)

    // ===== ZONE 4: Customer Declaration — hanging indents =====
    let dY = py + 10
    const paraX = Lx
    const paraW = pageRight - paraX

    doc.font('Helvetica-Bold').fontSize(10).text('Customer Declaration', Lx, dY)
    dY += rowGap
    doc.font('Helvetica').fontSize(9)
    dY = bulletPara(doc, { x: paraX, y: dY, width: paraW, number: 1,
      text: 'I hereby acknowledge that the MaxTT Tyre Sealant installation has been completed on my vehicle to my satisfaction, as per my earlier consent to proceed.',
      align: 'justify', gap: 10
    })
    dY = bulletPara(doc, { x: paraX, y: dY, width: paraW, number: 2,
      text: 'I have read, understood, and accepted the Terms & Conditions stated herein.',
      align: 'justify', gap: 10
    })
    dY = bulletPara(doc, { x: paraX, y: dY, width: paraW, number: 3,
      text: 'I acknowledge that the total amount shown is correct and payable to the franchisee/installer of Treadstone Solutions.',
      align: 'justify', gap: 4
    })

    HLine(dY + 6)

    // ===== ZONE 5: Terms & Conditions — hanging indents + updated point 3 =====
    let tY = dY + 14
    doc.font('Helvetica-Bold').fontSize(10).text('Terms & Conditions', Lx, tY)
    tY += rowGap
    doc.font('Helvetica').fontSize(9)
    tY = bulletPara(doc, { x: paraX, y: tY, width: paraW, number: 1,
      text: 'The MaxTT Tyre Sealant is a preventive safety solution designed to reduce tyre-related risks and virtually eliminate punctures and blowouts.',
      align: 'justify', gap: 10
    })
    tY = bulletPara(doc, { x: paraX, y: tY, width: paraW, number: 2,
      text: 'Effectiveness is assured only when the vehicle is operated within the speed limits prescribed by competent traffic/transport authorities (RTO/Transport Department) in India.',
      align: 'justify', gap: 10
    })
    tY = bulletPara(doc, { x: paraX, y: tY, width: paraW, number: 3,
      text: 'By signing/accepting this invoice, the customer affirms that the installation has been carried out to their satisfaction and agrees to abide by these conditions. Jurisdiction: Gurgaon.',
      align: 'justify', gap: 10
    })

    // Signature boxes
    const sigY = tY + 4
    const boxW = 240, boxH = 62, gap = 44
    doc.roundedRect(pageLeft, sigY, boxW, boxH, 6).stroke()
    doc.font('Helvetica').fontSize(9).text('Customer Signature', pageLeft+10, sigY+boxH-18)
    doc.roundedRect(pageLeft + boxW + gap, sigY, boxW, boxH, 6).stroke()
    doc.font('Helvetica').fontSize(9).text('Installer Signature & Company Stamp', pageLeft + boxW + gap + 10, sigY+boxH-18)
    doc.text(`Signed at: ${fmtIST(inv.created_at)}`, pageLeft, sigY + boxH + 12)

    doc.end()
    doc.on('end', resolve)
    doc.on('error', reject)
  })
}
