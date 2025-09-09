// pdf/invoice_v46.js — v46 single-page layout (refined, aligned)
// Updates per your notes:
// ZONE 1
// • Add “Contact No / Email ID” row for Franchisee
// • “Invoice No” in bold
// • Left/right rows synced to a neat grid
// ZONE 2
// • Left: “Customer Details” (as finalized earlier)
// • Right: “Vehicle Details”; first 4 rows’ VALUES align with the Fitment/Tread value column
// • “Position” and “Tread (mm)” bold
// ZONE 3
// • “Description/Particulars” vs “Value”; right column aligned with Zone 2’s right VALUE column
// ZONE 4 & 5
// • Justified paragraphs, consistent spacing, aligned continuations
// • Zone 5 point 3 text updated
// • Two aligned signature boxes

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

export async function createV46Pdf(stream, inv, fr) {
  return new Promise((resolve,reject)=>{
    const doc = new PDFDocument({ size:'A4', margin:36 })
    doc.pipe(stream)

    // ---- Layout constants / grid ----
    const pageLeft = 36, pageRight = 556
    const Lx = 44, Lw = 250
    const Rx = 300, Rw = 248
    const RxVal = Rx + 180         // right VALUE column x (aligns with Fitment/Tread values)
    const RvW = pageRight - RxVal  // width for right-side values
    const rowGap = 14              // tight line height for rows
    const paraGap = 18             // paragraph spacing for decl/T&C
    const thin = 0.5
    const HLine = (y)=> { doc.moveTo(pageLeft, y).lineTo(pageRight, y).lineWidth(thin).stroke() }

    // ===== ZONE 1: Header (synced rows) =====
    const frName  = safe(fr?.legal_name,'Franchisee')
    const frAddr  = safe([fr?.address1, fr?.address2].filter(Boolean).join(', '), 'Address not set')
    const frCode  = safe(inv.franchisee_id || inv.franchisee_code)
    const frGstin = safe(fr?.gstin, '—')
    const frPhone = safe(fr?.phone, '—')
    const frEmail = safe(fr?.email, '—')
    const printed = inv.invoice_number || printedFromNorm(inv.invoice_number_norm, inv.id)

    // grid base
    let y = 36
    doc.font('Helvetica-Bold').fontSize(12).text(frName, Lx, y, { width: 322 })
    // Right column row 1: Invoice No (bold)
    doc.font('Helvetica-Bold').fontSize(10).text(`Invoice No: ${printed}`, 352, y+4, { width: 204 })
    y += rowGap + 4

    // Row 2
    doc.font('Helvetica').fontSize(9).text(frAddr, Lx, y, { width: 322 })
    doc.font('Helvetica').fontSize(10).text(`Date: ${fmtIST(inv.created_at)}`, 352, y, { width: 204 })
    y += rowGap

    // Row 3
    doc.font('Helvetica').fontSize(9).text(`Franchisee ID: ${frCode}`, Lx, y, { width: 322 })
    // keep right blank to preserve grid symmetry
    y += rowGap

    // Row 4
    doc.font('Helvetica').fontSize(9).text(`GSTIN: ${frGstin}`, Lx, y, { width: 322 })
    y += rowGap

    // Row 5 (NEW): Contact & Email
    doc.font('Helvetica').fontSize(9).text(`Contact: ${frPhone}  |  Email: ${frEmail}`, Lx, y, { width: 322 })
    y += rowGap - 2

    // Separator for Zone 1 (moved up slightly vs prior)
    HLine(y)

    // ===== ZONE 2: Customer (Left) & Vehicle (Right) =====
    y += 8
    const z2HeadY = y
    doc.font('Helvetica-Bold').fontSize(10).text('Customer Details', Lx, y)
    doc.font('Helvetica-Bold').fontSize(10).text('Vehicle Details',  Rx, y)
    y += rowGap

    // Left column rows (as finalized)
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

    // Right column rows (first 4 with VALUE aligned to RxVal)
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
      // key at Rx; value aligned with RxVal to line up with tread values
      doc.text(`${k}:`, Rx, ry, { width: 170 })
      doc.text(String(v), RxVal, ry, { width: RvW, align: 'left' })
      ry += rowGap
    }

    // Subheading + headers (bold)
    doc.font('Helvetica-Bold').fontSize(10).text('Fitment & Tread Depth (mm)', Rx, ry); ry += rowGap
    doc.font('Helvetica-Bold').fontSize(9).text('Position', Rx, ry)
    doc.font('Helvetica-Bold').fontSize(9).text('Tread (mm)', RxVal, ry, { width: 80, align:'left' })
    ry += rowGap

    // Tread rows (values at RxVal column)
    doc.font('Helvetica').fontSize(10)
    const treadRows = [
      ['Front Left',  safe(inv.tread_fl_mm)],
      ['Front Right', safe(inv.tread_fr_mm)],
      ['Rear Left',   safe(inv.tread_rl_mm)],
      ['Rear Right',  safe(inv.tread_rr_mm)],
    ]
    for (const [pos, val] of treadRows){
      doc.text(pos, Rx, ry, { width: 170 })
      doc.text(val, RxVal, ry, { width: 80, align:'left' })
      ry += rowGap
    }

    // Dosages (values aligned with RxVal)
    const perTyre = inv.tyre_count ? Math.round((Number(inv.dosage_ml||0) / Number(inv.tyre_count))*10)/10 : null
    doc.text('Per-tyre Dosage:', Rx, ry, { width: 170 })
    doc.text(perTyre ? `${perTyre} ml` : '—', RxVal, ry, { width: 80, align:'left' })
    ry += rowGap
    doc.text('Total Dosage:', Rx, ry, { width: 170 })
    doc.text(`${safe(inv.dosage_ml)} ml`, RxVal, ry, { width: 80, align:'left' })
    ry += rowGap

    // Separator for Zone 2
    const z2Bottom = Math.max(ly, ry) + 6
    HLine(z2Bottom)

    // ===== ZONE 3: Pricing (right column aligned with RxVal) =====
    let py = z2Bottom + 8
    doc.font('Helvetica-Bold').fontSize(10).text('Description/Particulars', Lx, py)
    doc.font('Helvetica-Bold').fontSize(10).text('Value', Rx, py) // heading label column
    doc.font('Helvetica-Bold').fontSize(10).text('', RxVal, py)   // value col header placeholder (keeps grid)
    py += rowGap

    const V = (label, value) => {
      doc.font('Helvetica').fontSize(10).text(label, Lx, py)
      // place the VALUE label at Rx and the value itself aligned at RxVal (same column as Zone 2 values)
      doc.font('Helvetica').fontSize(10).text('', Rx, py)
      doc.font('Helvetica').fontSize(10).text(value, RxVal, py, { width: RvW, align:'left' })
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

    // ===== ZONE 4: Customer Declaration (justified, even spacing) =====
    let dY = py + 10
    const paraW = 520
    doc.font('Helvetica-Bold').fontSize(10).text('Customer Declaration', pageLeft, dY)
    dY += rowGap
    doc.font('Helvetica').fontSize(9)
      .text(
        '1. I hereby acknowledge that the MaxTT Tyre Sealant installation has been completed on my vehicle to my satisfaction, as per my earlier consent to proceed.',
        pageLeft, dY, { width: paraW, align: 'justify' }
      )
    dY += paraGap
    doc.text(
        '2. I have read, understood, and accepted the Terms & Conditions stated herein.',
        pageLeft, dY, { width: paraW, align: 'justify' }
      )
    dY += paraGap
    doc.text(
        '3. I acknowledge that the total amount shown is correct and payable to the franchisee/installer of Treadstone Solutions.',
        pageLeft, dY, { width: paraW, align: 'justify' }
      )
    dY += 4

    HLine(dY + 14)

    // ===== ZONE 5: Terms & Conditions (justified) + signature boxes =====
    let tY = dY + 22
    doc.font('Helvetica-Bold').fontSize(10).text('Terms & Conditions', pageLeft, tY)
    tY += rowGap
    doc.font('Helvetica').fontSize(9)
      .text(
        '1. The MaxTT Tyre Sealant is a preventive safety solution designed to reduce tyre-related risks and virtually eliminate punctures and blowouts.',
        pageLeft, tY, { width: paraW, align: 'justify' }
      )
    tY += paraGap
    doc.text(
        '2. Effectiveness is assured only when the vehicle is operated within the speed limits prescribed by competent traffic/transport authorities (RTO/Transport Department) in India.',
        pageLeft, tY, { width: paraW, align: 'justify' }
      )
    tY += paraGap
    doc.text(
        '3. By signing/accepting this invoice, the customer affirms that the installation has been carried out to their satisfaction and agrees to abide by these conditions. Jurisdiction: Gurgaon.',
        pageLeft, tY, { width: paraW, align: 'justify' }
      )
    tY += 10

    // Signature boxes (aligned)
    const sigY = tY + 10
    const boxW = 240, boxH = 62, gap = 44
    // Left: Customer Signature
    doc.roundedRect(pageLeft, sigY, boxW, boxH, 6).stroke()
    doc.font('Helvetica').fontSize(9).text('Customer Signature', pageLeft+10, sigY+boxH-18)
    // Right: Installer Signature & Company Stamp
    doc.roundedRect(pageLeft + boxW + gap, sigY, boxW, boxH, 6).stroke()
    doc.font('Helvetica').fontSize(9).text('Installer Signature & Company Stamp', pageLeft + boxW + gap + 10, sigY+boxH-18)

    // Signed at:
    doc.font('Helvetica').fontSize(9).text(`Signed at: ${fmtIST(inv.created_at)}`, pageLeft, sigY + boxH + 12)

    doc.end()
    doc.on('end', resolve)
    doc.on('error', reject)
  })
}
