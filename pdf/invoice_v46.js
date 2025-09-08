// pdf/invoice_v46.js — v46 layout clone (no logo/watermark)
// Fixes applied:
// A) Customer ID now shows *invoice_number_norm* (norm-style), never C000###.  :contentReference[oaicite:0]{index=0}
// B) Declaration & T&C wrapping tightened (wider text area + slightly smaller font), signature boxes aligned.  :contentReference[oaicite:1]{index=1}
 // C) Franchisee GSTIN shows "—" when empty (no blank line).  :contentReference[oaicite:2]{index=2}
 // D) Header/zone Y positions nudged to match v46 rhythm.

import PDFDocument from 'pdfkit'

// helpers
const safe = (v, alt='—') => (v === null || v === undefined || String(v).trim()==='') ? alt : String(v)
const inr = (n, digits=2) =>
  'Rs. ' + Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:digits,maximumFractionDigits:digits})
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

export async function createV46Pdf(stream, inv, fr) {
  return new Promise((resolve,reject)=>{
    const doc = new PDFDocument({ size:'A4', margin:36 })
    doc.pipe(stream)

    // === Header (v46 two-column box) ===
    // Left (franchisee)
    const frName = safe(fr?.legal_name,'Franchisee')
    const frAddr = safe([fr?.address1, fr?.address2].filter(Boolean).join(', '), 'Address not set')
    const frCode = safe(inv.franchisee_id || inv.franchisee_code)
    const frGstin = safe(fr?.gstin, '—') // C) never blank

    doc.font('Helvetica-Bold').fontSize(12).text(frName, 36, 36, { width: 322 })
    doc.font('Helvetica').fontSize(9)
      .text(frAddr, 36, 54, { width: 322 })
      .text(`Franchisee ID: ${frCode}`, 36, 68, { width: 322 })
      .text(`GSTIN: ${frGstin}`, 36, 82, { width: 322 })

    // Right (invoice meta box)
    const boxX = 352, boxY = 36, boxW = 204, boxH = 60
    doc.roundedRect(boxX, boxY, boxW, boxH, 6).stroke()
    doc.font('Helvetica').fontSize(10)

    const printed = inv.invoice_number || (inv.invoice_number_norm ? (()=> {
      const m = String(inv.invoice_number_norm).match(/^(.*)-(\d{4})$/)
      if (!m) return `INV-${inv.id}`
      const seq = m[2]
      const d = new Date(); const mm = String(d.getUTCMonth()+1).padStart(2,'0'); const yy = String(d.getUTCFullYear()).slice(-2)
      return `${m[1]}/${mm}${yy}/${seq}`
    })() : `INV-${inv.id}`)

    doc.text(`Invoice No: ${printed}`, boxX+8, boxY+8,  { width: boxW-16 })
    doc.text(`Date: ${fmtIST(inv.created_at)}`, boxX+8, boxY+28, { width: boxW-16 })

    // === Zone 2: Customer Details ===
    const z2Y = 108  // D) nudge up slightly to match v46
    doc.roundedRect(36, z2Y, 520, 96, 6).stroke()
    doc.font('Helvetica-Bold').fontSize(10).text('Customer Details', 44, z2Y+6)
    doc.font('Helvetica').fontSize(10)
    doc.text(`Name: ${safe(inv.customer_name)}`,        44,  z2Y+22, { width: 260 })
    doc.text(`Mobile: ${safe(inv.mobile_number)}`,      300, z2Y+22, { width: 248 })
    doc.text(`Vehicle: ${safe(inv.vehicle_number)}`,    44,  z2Y+38, { width: 260 })
    doc.text(`Odometer Reading: ${safe(inv.odometer)} km`, 300, z2Y+38, { width: 248 })
    doc.text(`Customer GSTIN: ${safe(inv.customer_gstin)}`, 44,  z2Y+54, { width: 260 })
    doc.text(`Address: ${safe(inv.customer_address)}`,  300, z2Y+54, { width: 248 })
    doc.text(`Installer: ${safe(inv.installer_name)}`,  44,  z2Y+70, { width: 260 })
    const hsn = inv.hsn_code || '35069999'
    doc.text(`HSN Code: ${hsn}`,                        300, z2Y+70, { width: 248 })
    // A) Force norm-style Customer ID (never C000###)
    const custId = safe(inv.invoice_number_norm) // norm style like TS-HR-GGM-001-0010
    doc.text(`Customer ID: ${custId}`,                  44,  z2Y+86, { width: 260 })

    // === Zone 3: Vehicle Details ===
    const z3Y = z2Y + 110
    doc.roundedRect(36, z3Y, 520, 58, 6).stroke()
    doc.font('Helvetica-Bold').fontSize(10).text('Vehicle Details', 44, z3Y+6)
    doc.font('Helvetica').fontSize(10)
    doc.text(`Category: ${safe(inv.vehicle_type,'—')}`, 44,  z3Y+22, { width: 260 })
    doc.text(`Tyres: ${safe(inv.tyre_count)}`,         300, z3Y+22, { width: 248 })
    const installed = safe(inv.fitment_locations,'') || `${safe(inv.tyre_count)}`
    doc.text(`Installed Tyres: ${installed}`,          44,  z3Y+38, { width: 260 })
    const tyreSize = tyreSizeFmt(inv.tyre_width_mm, inv.aspect_ratio, inv.rim_diameter_in)
    doc.text(`Tyre Size: ${tyreSize}`,                 300, z3Y+38, { width: 248 })

    // === Zone 4: Fitment & Tread Depth ===
    const z4Y = z3Y + 72
    const z4BoxH = 88
    doc.roundedRect(36, z4Y, 520, z4BoxH, 6).stroke()
    doc.font('Helvetica-Bold').fontSize(10).text('Fitment & Tread Depth (mm)', 44, z4Y+6)
    doc.font('Helvetica').fontSize(9).text('Position', 44, z4Y+24)
    doc.text('Tread (mm)', 300, z4Y+24, { width: 248 })
    const rows = [
      ['Front Left',  safe(inv.tread_fl_mm)],
      ['Front Right', safe(inv.tread_fr_mm)],
      ['Rear Left',   safe(inv.tread_rl_mm)],
      ['Rear Right',  safe(inv.tread_rr_mm)],
    ]
    let ry = z4Y + 40
    for (const [pos, val] of rows){
      doc.font('Helvetica').fontSize(10).text(pos, 44, ry,  { width: 248 })
      doc.text(val,                              300, ry,  { width: 248 })
      ry += 16
    }
    const perTyre = inv.tyre_count ? Math.round((Number(inv.dosage_ml||0) / Number(inv.tyre_count))*10)/10 : null
    doc.text(`Per-tyre Dosage: ${perTyre ? perTyre+' ml' : '—'}`, 44,  z4Y + z4BoxH - 14)
    doc.text(`Total Dosage: ${safe(inv.dosage_ml)} ml`,          300, z4Y + z4BoxH - 14)

    // === Zone 5: Pricing (desc/value, three tax lines, three totals) ===
    const z5Y = z4Y + z4BoxH + 14
    doc.roundedRect(36, z5Y, 520, 156, 6).stroke()
    doc.font('Helvetica-Bold').fontSize(10).text('Description', 44, z5Y+6)
    doc.text('Value', 340, z5Y+6, { width: 212, align: 'right' })

    const Lx = 44, Rx = 340
    const V = (y, k, v) => { doc.font('Helvetica').fontSize(10).text(k, Lx, y); doc.text(v, Rx, y, { width: 212, align:'right' }) }
    const mrp = inv.price_per_ml ?? 4.5
    V(z5Y+22, 'Total Dosage (ml)', safe(inv.dosage_ml,'—'))
    V(z5Y+38, 'MRP per ml', inr(mrp, 2))
    V(z5Y+54, 'Gross', inr(inv.total_before_gst || (Number(inv.dosage_ml||0)*Number(mrp||0))))
    if (inv.discount_amount != null)      V(z5Y+70, 'Discount', `- ${inr(inv.discount_amount)}`)
    if (inv.installation_charges != null) V(z5Y+86, 'Installation Charges', inr(inv.installation_charges))
    const gstRate = Number(inv.gst_rate ?? 18)
    const half = gstRate/2
    const isIGST = String(inv.tax_mode||'').toUpperCase().includes('IGST')
    if (isIGST) {
      V(z5Y+102, 'Tax Mode', 'IGST')
      V(z5Y+118, `IGST (${gstRate}%)`, inr(inv.gst_amount ?? 0))
      V(z5Y+134, `CGST (${half}%)`, inr(0))
      V(z5Y+150, `SGST (${half}%)`, inr(0))
    } else {
      V(z5Y+102, 'Tax Mode', 'CGST+SGST')
      const halfAmt = (Number(inv.gst_amount ?? 0) / 2)
      V(z5Y+118, `CGST (${half}%)`, inr(halfAmt))
      V(z5Y+134, `SGST (${half}%)`, inr(halfAmt))
      V(z5Y+150, `IGST (${gstRate}%)`, inr(0))
    }

    // Totals line + three totals
    doc.moveTo(36, z5Y+172).lineTo(556, z5Y+172).stroke()
    const TL = (t,y)=> doc.font('Helvetica-Bold').fontSize(10).text(t, 44, y)
    const TV = (t,y)=> doc.font('Helvetica').fontSize(10).text(t, 340, y, { width:212, align:'right' })
    TL('Amount (before GST)', z5Y+178); TV(inr(inv.total_before_gst ?? 0), z5Y+178)
    TL('GST Total',           z5Y+194); TV(inr(inv.gst_amount ?? 0),      z5Y+194)
    TL('Total (with GST)',    z5Y+210); TV(inr(inv.total_with_gst ?? 0),  z5Y+210)

    // === Declarations & Signatures (B: wider text + slightly smaller font) ===
    const decY = z5Y + 230
    doc.font('Helvetica-Bold').fontSize(9).text('Customer Declaration', 36, decY, { underline:true })
    doc.font('Helvetica').fontSize(8.7) // slightly smaller to avoid mid-phrase wraps
      .text('1. I hereby acknowledge that the MaxTT Tyre Sealant installation has been completed on my vehicle to my satisfaction, as per my earlier consent to proceed.', 36, decY+14, { width: 528 })
      .text('2. I have read, understood, and accepted the Terms & Conditions stated herein.', 36, decY+30, { width: 528 })
      .text('3. I acknowledge that the total amount shown is correct and payable to the franchisee/installer of Treadstone Solutions.', 36, decY+46, { width: 528 })

    doc.font('Helvetica-Bold').fontSize(9).text('Terms & Conditions', 36, decY+66, { underline:true })
    doc.font('Helvetica').fontSize(8.7)
      .text('1. The MaxTT Tyre Sealant is a preventive safety solution designed to reduce tyre-related risks and virtually eliminate punctures and blowouts.', 36, decY+80, { width: 528 })
      .text('2. Effectiveness is assured only when the vehicle is operated within the speed limits prescribed by competent traffic/transport authorities (RTO/Transport Department) in India.', 36, decY+96, { width: 528 })
      .text('3. Jurisdiction: Gurgaon.', 36, decY+112, { width: 528 })

    // Signature boxes aligned on same row
    const sigY = decY + 132
    doc.rect(36,  sigY, 240, 58).stroke()
    doc.rect(320, sigY, 240, 58).stroke()
    doc.font('Helvetica').fontSize(9)
      .text('Installer Signature & Stamp', 44,  sigY+42)
      .text('Customer Accepted & Confirmed', 328, sigY+42)
    doc.text(`Signed at: ${fmtIST(inv.created_at)}`, 36, sigY+70)

    doc.end()
    doc.on('end', resolve)
    doc.on('error', reject)
  })
}
