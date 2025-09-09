// pdf/invoice_v46.js — v46 single-page layout (refined)
// Changes per your spec:
// • Thin horizontal lines between zones (no big boxes).
// • Zone 1 separator moved up slightly.
// • Zone 2 split strictly: LEFT = "Customer Details" (10 rows incl. heading),
//   RIGHT = "Vehicle Details" (13 rows incl. heading & subheading).
// • Zone 3: "Description/Particulars" vs "Value" (13 rows incl. heading).
// • Zone 4: "Customer Declaration" (3 points, justified).
// • Zone 5: "Terms & Conditions" (3 points, justified) + TWO SIGNATURE BOXES aligned.
// • Reduced line gaps so content stays on one page.
// • Customer ID uses invoice_number_norm (norm style). Tyre size formatter keeps “195/65 R17” or “195 R15” when aspect missing.

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

    const HLine = (y)=> { doc.moveTo(36, y).lineTo(556, y).lineWidth(0.5).stroke() }
    const Lx = 44, Rx = 300, Lw = 250, Rw = 248
    const rowGap = 14 // tighter row spacing

    // ===== Zone 1: Header =====
    const frName  = safe(fr?.legal_name,'Franchisee')
    const frAddr  = safe([fr?.address1, fr?.address2].filter(Boolean).join(', '), 'Address not set')
    const frCode  = safe(inv.franchisee_id || inv.franchisee_code)
    const frGstin = safe(fr?.gstin, '—')
    const printed = inv.invoice_number || printedFromNorm(inv.invoice_number_norm, inv.id)

    // Left header (franchisee)
    doc.font('Helvetica-Bold').fontSize(12).text(frName, 36, 36, { width: 322 })
    doc.font('Helvetica').fontSize(9)
      .text(frAddr,                     36, 54, { width: 322 })
      .text(`Franchisee ID: ${frCode}`, 36, 68, { width: 322 })
      .text(`GSTIN: ${frGstin}`,        36, 82, { width: 322 })

    // Right header (stacked, no box)
    doc.font('Helvetica').fontSize(10)
      .text(`Invoice No: ${printed}`,        352, 40, { width: 204 })
      .text(`Date: ${fmtIST(inv.created_at)}`, 352, 58, { width: 204 })

    // Separator after Zone 1 (moved up ~ one row)
    HLine(96)

    // ===== Zone 2: Customer & Vehicle =====
    let y = 104 + 8 // start a bit below the line
    // Headings
    doc.font('Helvetica-Bold').fontSize(10).text('Customer Details', Lx, y)
    doc.font('Helvetica-Bold').fontSize(10).text('Vehicle Details',  Rx, y)
    y += rowGap

    doc.font('Helvetica').fontSize(10)
    // LEFT (Customer): Name; Address; Contact Number; Customer GSTIN; Vehicle Number; Odometer reading; Customer ID; Installer name; HSN CODE
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

    // RIGHT (Vehicle): Category; Tyres; Installed In Tyres; Tyre Size; subheading; Position/Tread header; 4 rows; Per-tyre; Total
    const tyreSize = tyreSizeFmt(inv.tyre_width_mm, inv.aspect_ratio, inv.rim_diameter_in)
    const installed = safe(inv.fitment_locations,'') || `${safe(inv.tyre_count)}`
    const vehicleRows = [
      ['Category',              safe(inv.vehicle_type,'4-Wheeler (Car/Van/SUV)')], // default label as per your example
      ['Tyres',                 safe(inv.tyre_count)],
      ['Installed In Tyres',    installed],
      ['Tyre Size',             tyreSize],
    ]
    let ry = y
    for (const [k,v] of vehicleRows){
      doc.text(`${k}: ${v}`, Rx, ry, { width: Rw })
      ry += rowGap
    }

    // Subheading
    doc.font('Helvetica-Bold').fontSize(10).text('Fitment & Tread Depth (mm)', Rx, ry); ry += rowGap
    doc.font('Helvetica').fontSize(9)
      .text('Position', Rx, ry)
      .text('Tread (mm)', Rx + 180, ry, { width: 68, align:'left' })
    ry += rowGap

    // Tread rows
    const treadRows = [
      ['Front Left',  safe(inv.tread_fl_mm)],
      ['Front Right', safe(inv.tread_fr_mm)],
      ['Rear Left',   safe(inv.tread_rl_mm)],
      ['Rear Right',  safe(inv.tread_rr_mm)],
    ]
    doc.font('Helvetica').fontSize(10)
    for (const [pos, val] of treadRows){
      doc.text(pos, Rx, ry, { width: 170 })
      doc.text(val, Rx + 180, ry, { width: 68, align:'left' })
      ry += rowGap
    }

    // Dosages
    const perTyre = inv.tyre_count ? Math.round((Number(inv.dosage_ml||0) / Number(inv.tyre_count))*10)/10 : null
    doc.text(`Per-tyre Dosage: ${perTyre ? perTyre+' ml' : '—'}`, Rx, ry); ry += rowGap
    doc.text(`Total Dosage: ${safe(inv.dosage_ml)} ml`,       Rx, ry); ry += rowGap

    // Separator after Zone 2
    const z2Bottom = Math.max(ly, ry) + 6
    HLine(z2Bottom)

    // ===== Zone 3: Pricing =====
    y = z2Bottom + 8
    doc.font('Helvetica-Bold').fontSize(10).text('Description/Particulars', Lx, y)
    doc.font('Helvetica-Bold').fontSize(10).text('Value',                   340, y, { width: 212, align:'right' })
    y += rowGap

    const V = (label, value) => {
      doc.font('Helvetica').fontSize(10).text(label, Lx, y)
      doc.font('Helvetica').fontSize(10).text(value, 340, y, { width: 212, align:'right' })
      y += rowGap
    }
    const mrp = inv.price_per_ml ?? 4.5
    const gross = inv.total_before_gst ?? (Number(inv.dosage_ml||0) * Number(mrp||0))
    const gstRate = Number(inv.gst_rate ?? 18)
    const halfRate = gstRate/2
    const isIGST = String(inv.tax_mode||'').toUpperCase().includes('IGST')
    const gstTotal = Number(inv.gst_amount ?? Math.round(gross * gstRate/100))
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

    // Separator after Zone 3
    HLine(y + 2)

    // ===== Zone 4: Customer Declaration (justified) =====
    let dY = y + 10
    doc.font('Helvetica-Bold').fontSize(10).text('Customer Declaration', 36, dY)
    dY += rowGap
    doc.font('Helvetica').fontSize(9)
      .text(
        '1. I hereby acknowledge that the MaxTT Tyre Sealant installation has been completed on my vehicle to my satisfaction, as per my earlier consent to proceed.',
        36, dY, { width: 520, align: 'justify' }
      ); dY += 18
    doc.text(
        '2. I have read, understood, and accepted the Terms & Conditions stated herein.',
        36, dY, { width: 520, align: 'justify' }
      ); dY += 18
    doc.text(
        '3. I acknowledge that the total amount shown is correct and payable to the franchisee/installer of Treadstone Solutions.',
        36, dY, { width: 520, align: 'justify' }
      ); dY += 4

    // Separator after Zone 4
    HLine(dY + 14)

    // ===== Zone 5: Terms & Conditions (justified) + two signature boxes =====
    let tY = dY + 22
    doc.font('Helvetica-Bold').fontSize(10).text('Terms & Conditions', 36, tY)
    tY += rowGap
    doc.font('Helvetica').fontSize(9)
      .text(
        '1. The MaxTT Tyre Sealant is a preventive safety solution designed to reduce tyre-related risks and virtually eliminate punctures and blowouts.',
        36, tY, { width: 520, align: 'justify' }
      ); tY += 18
    doc.text(
        '2. Effectiveness is assured only when the vehicle is operated within the speed limits prescribed by competent traffic/transport authorities (RTO/Transport Department) in India.',
        36, tY, { width: 520, align: 'justify' }
      ); tY += 18
    doc.text(
        '3. Jurisdiction: Gurgaon.',
        36, tY, { width: 520, align: 'justify' }
      ); tY += 10

    // Signature boxes (aligned, neat)
    const sigY = tY + 10
    const boxW = 240, boxH = 62, gap = 44
    // Left box
    doc.roundedRect(36, sigY, boxW, boxH, 6).stroke()
    doc.font('Helvetica').fontSize(9).text('Customer Signature', 36+10, sigY+boxH-18)
    // Right box
    doc.roundedRect(36 + boxW + gap, sigY, boxW, boxH, 6).stroke()
    doc.font('Helvetica').fontSize(9).text('Installer Signature & Company Stamp', 36 + boxW + gap + 10, sigY+boxH-18)

    // Signed at:
    doc.font('Helvetica').fontSize(9).text(`Signed at: ${fmtIST(inv.created_at)}`, 36, sigY + boxH + 12)

    doc.end()
    doc.on('end', resolve)
    doc.on('error', reject)
  })
}
