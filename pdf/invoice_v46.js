// pdf/invoice_v46.js — v46 layout clone (no logo/watermark)
// Changes in this version:
// 1) Zone 2 = strict 2 columns:
//    - LEFT: all Customer fields (Name, Mobile, Customer GSTIN, Address, Installer, HSN Code, Customer ID)
//    - RIGHT: all Vehicle fields (Vehicle No, Odometer, Vehicle Type, Tyre Size, Tyre Count, Fitment Locations)
// 2) Customer ID always from invoice_number_norm (norm style “TS-…-####”), never “C000###”.
// 3) Other zones kept intact (Fitment/Tread, Pricing, Declarations, Signatures).

import PDFDocument from 'pdfkit'

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

    // ===== Header (Franchisee left, meta box right) =====
    const frName  = safe(fr?.legal_name,'Franchisee')
    const frAddr  = safe([fr?.address1, fr?.address2].filter(Boolean).join(', '), 'Address not set')
    const frCode  = safe(inv.franchisee_id || inv.franchisee_code)
    const frGstin = safe(fr?.gstin, '—')

    doc.font('Helvetica-Bold').fontSize(12).text(frName, 36, 36, { width: 322 })
    doc.font('Helvetica').fontSize(9)
      .text(frAddr,                       36, 54, { width: 322 })
      .text(`Franchisee ID: ${frCode}`,   36, 68, { width: 322 })
      .text(`GSTIN: ${frGstin}`,          36, 82, { width: 322 })

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

    doc.text(`Invoice No: ${printed}`,     boxX+8, boxY+8,  { width: boxW-16 })
    doc.text(`Date: ${fmtIST(inv.created_at)}`, boxX+8, boxY+28, { width: boxW-16 })

    // ===== Zone 2: Two-column panel (Customer LEFT, Vehicle RIGHT) =====
    const z2Y = 108
    const z2H = 110
    doc.roundedRect(36, z2Y, 520, z2H, 6).stroke()
    doc.font('Helvetica-Bold').fontSize(10).text('Customer & Vehicle Details', 44, z2Y+6)

    // Column widths
    const Lx = 44,  Lw = 250
    const Rx = 300, Rw = 248
    let ly = z2Y + 22
    let ry = z2Y + 22
    doc.font('Helvetica').fontSize(10)

    // LEFT (Customer)
    const hsn = inv.hsn_code || '35069999'
    const custId = safe(inv.invoice_number_norm) // norm style
    const leftRows = [
      ['Name',            safe(inv.customer_name)],
      ['Mobile',          safe(inv.mobile_number)],
      ['Customer GSTIN',  safe(inv.customer_gstin)],
      ['Address',         safe(inv.customer_address)],
      ['Installer',       safe(inv.installer_name)],
      ['HSN Code',        hsn],
      ['Customer ID',     custId],
    ]
    for (const [k,v] of leftRows){
      doc.text(`${k}: ${v}`, Lx, ly, { width: Lw })
      ly += 16
    }

    // RIGHT (Vehicle)
    const tyreSize = tyreSizeFmt(inv.tyre_width_mm, inv.aspect_ratio, inv.rim_diameter_in)
    const installed = safe(inv.fitment_locations,'') || `${safe(inv.tyre_count)}`
    const rightRows = [
      ['Vehicle',          safe(inv.vehicle_number)],
      ['Odometer Reading', safe(inv.odometer) === '—' ? '—' : `${safe(inv.odometer)} km`],
      ['Vehicle Type',     safe(inv.vehicle_type,'—')],
      ['Tyre Size',        tyreSize],
      ['Tyre Count',       safe(inv.tyre_count)],
      ['Installed Tyres',  installed],
    ]
    for (const [k,v] of rightRows){
      doc.text(`${k}: ${v}`, Rx, ry, { width: Rw })
      ry += 16
    }

    // ===== Zone 3: Fitment & Tread Depth (unchanged layout) =====
    const z3Y = z2Y + z2H + 14
    const z3H = 88
    doc.roundedRect(36, z3Y, 520, z3H, 6).stroke()
    doc.font('Helvetica-Bold').fontSize(10).text('Fitment & Tread Depth (mm)', 44, z3Y+6)
    doc.font('Helvetica').fontSize(9).text('Position', 44, z3Y+24)
    doc.text('Tread (mm)', 300, z3Y+24, { width: 248 })
    const rows = [
      ['Front Left',  safe(inv.tread_fl_mm)],
      ['Front Right', safe(inv.tread_fr_mm)],
      ['Rear Left',   safe(inv.tread_rl_mm)],
      ['Rear Right',  safe(inv.tread_rr_mm)],
    ]
    let ry2 = z3Y + 40
    for (const [pos, val] of rows){
      doc.font('Helvetica').fontSize(10).text(pos, 44,  ry2, { width: 248 })
      doc.text(val,                              300, ry2, { width: 248 })
      ry2 += 16
    }
    const perTyre = inv.tyre_count ? Math.round((Number(inv.dosage_ml||0) / Number(inv.tyre_count))*10)/10 : null
    doc.text(`Per-tyre Dosage: ${perTyre ? perTyre+' ml' : '—'}`, 44,  z3Y + z3H - 14)
    doc.text(`Total Dosage: ${safe(inv.dosage_ml)} ml`,          300, z3Y + z3H - 14)

    // ===== Zone 4: Pricing (unchanged layout) =====
    const z4Y = z3Y + z3H + 14
    doc.roundedRect(36, z4Y, 520, 156, 6).stroke()
    doc.font('Helvetica-Bold').fontSize(10).text('Description', 44, z4Y+6)
    doc.text('Value', 340, z4Y+6, { width: 212, align: 'right' })
    const V = (y, k, v) => { doc.font('Helvetica').fontSize(10).text(k, 44, y); doc.text(v, 340, y, { width: 212, align:'right' }) }
    const mrp = inv.price_per_ml ?? 4.5
    V(z4Y+22, 'Total Dosage (ml)', safe(inv.dosage_ml,'—'))
    V(z4Y+38, 'MRP per ml', inr(mrp, 2))
    V(z4Y+54, 'Gross', inr(inv.total_before_gst || (Number(inv.dosage_ml||0)*Number(mrp||0))))
    if (inv.discount_amount != null)      V(z4Y+70, 'Discount', `- ${inr(inv.discount_amount)}`)
    if (inv.installation_charges != null) V(z4Y+86, 'Installation Charges', inr(inv.installation_charges))
    const gstRate = Number(inv.gst_rate ?? 18)
    const half = gstRate/2
    const isIGST = String(inv.tax_mode||'').toUpperCase().includes('IGST')
    if (isIGST) {
      V(z4Y+102, 'Tax Mode', 'IGST')
      V(z4Y+118, `IGST (${gstRate}%)`, inr(inv.gst_amount ?? 0))
      V(z4Y+134, `CGST (${half}%)`, inr(0))
      V(z4Y+150, `SGST (${half}%)`, inr(0))
    } else {
      V(z4Y+102, 'Tax Mode', 'CGST+SGST')
      const halfAmt = (Number(inv.gst_amount ?? 0) / 2)
      V(z4Y+118, `CGST (${half}%)`, inr(halfAmt))
      V(z4Y+134, `SGST (${half}%)`, inr(halfAmt))
      V(z4Y+150, `IGST (${gstRate}%)`, inr(0))
    }
    doc.moveTo(36, z4Y+172).lineTo(556, z4Y+172).stroke()
    const TL = (t,y)=> doc.font('Helvetica-Bold').fontSize(10).text(t, 44, y)
    const TV = (t,y)=> doc.font('Helvetica').fontSize(10).text(t, 340, y, { width:212, align:'right' })
    TL('Amount (before GST)', z4Y+178); TV(inr(inv.total_before_gst ?? 0), z4Y+178)
    TL('GST Total',           z4Y+194); TV(inr(inv.gst_amount ?? 0),      z4Y+194)
    TL('Total (with GST)',    z4Y+210); TV(inr(inv.total_with_gst ?? 0),  z4Y+210)

    // ===== Zone 5: Declarations & Signatures (as per v46) =====
    const decY = z4Y + 230
    doc.font('Helvetica-Bold').fontSize(9).text('Customer Declaration', 36, decY, { underline:true })
    doc.font('Helvetica').fontSize(8.7)
      .text('1. I hereby acknowledge that the MaxTT Tyre Sealant installation has been completed on my vehicle to my satisfaction, as per my earlier consent to proceed.', 36, decY+14, { width:528 })
      .text('2. I have read, understood, and accepted the Terms & Conditions stated herein.', 36, decY+30, { width:528 })
      .text('3. I acknowledge that the total amount shown is correct and payable to the franchisee/installer of Treadstone Solutions.', 36, decY+46, { width:528 })
    doc.font('Helvetica-Bold').fontSize(9).text('Terms & Conditions', 36, decY+66, { underline:true })
    doc.font('Helvetica').fontSize(8.7)
      .text('1. The MaxTT Tyre Sealant is a preventive safety solution designed to reduce tyre-related risks and virtually eliminate punctures and blowouts.', 36, decY+80, { width:528 })
      .text('2. Effectiveness is assured only when the vehicle is operated within the speed limits prescribed by competent traffic/transport authorities (RTO/Transport Department) in India.', 36, decY+96, { width:528 })
      .text('3. Jurisdiction: Gurgaon.', 36, decY+112, { width:528 })

    const sigY = decY + 132
    doc.rect(36,  sigY, 240, 58).stroke()
    doc.rect(320, sigY, 240, 58).stroke()
    doc.font('Helvetica').fontSize(9)
      .text('Installer Signature & Stamp',     44,  sigY+42)
      .text('Customer Accepted & Confirmed',  328,  sigY+42)
    doc.text(`Signed at: ${fmtIST(inv.created_at)}`, 36, sigY+70)

    doc.end()
    doc.on('end', resolve)
    doc.on('error', reject)
  })
}
