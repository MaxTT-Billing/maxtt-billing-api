// pdf/invoice_v46.js (ESM) — Legacy v46 layout, hardened money + tyre label
// API: createV46Pdf(res, invRow, franchiseeRow)

import PDFDocument from "pdfkit";

// -------- helpers --------
function asNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function indianGroup(n) {
  // Indian numbering (e.g., 12,34,567)
  const s = String(Math.round(asNumber(n, 0)));
  const last3 = s.slice(-3);
  const rem = s.slice(0, -3);
  return rem ? rem.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
}
function money(n) {
  return `Rs. ${indianGroup(n)}`;
}
function dateIso(iso) {
  try {
    const d = new Date(iso || Date.now());
    return d.toISOString().replace("T", " ").replace("Z", " UTC");
  } catch {
    return String(iso || "");
  }
}
function tyreSizeLabel(inv) {
  const w = asNumber(inv?.tyre_width_mm);
  const a = asNumber(inv?.aspect_ratio);
  const r = asNumber(inv?.rim_diameter_in);
  if (!w || !r) return "";
  return a > 0 ? `${w}/${a} R${r}` : `${w} R${r}`;
}
function field(v) {
  const s = (v ?? "").toString().trim();
  return s ? s : "—";
}
function drawTitle(doc, text, y) {
  doc.font("Helvetica-Bold").fontSize(16).text(text, 50, y);
  doc.fontSize(10);
}
function section(doc, title, y) {
  doc.moveTo(50, y).lineTo(545, y).strokeColor("#000").lineWidth(1).stroke();
  doc.font("Helvetica-Bold").fontSize(12).text(title, 50, y + 10);
  doc.fontSize(10).fillColor("#000");
  doc.moveTo(50, y + 28).lineTo(545, y + 28).strokeColor("#ddd").lineWidth(1).stroke();
}
function kv(doc, y, pairs, colGap = 280) {
  // pairs: [[label, value], [label, value]]
  const L = 115; // label width
  const X1 = 50;
  const X2 = X1 + colGap;
  // row 1
  if (pairs[0]) {
    doc.font("Helvetica-Bold").text(pairs[0][0], X1, y, { width: L });
    doc.font("Helvetica").text(field(pairs[0][1]), X1 + L + 6, y);
  }
  if (pairs[1]) {
    doc.font("Helvetica-Bold").text(pairs[1][0], X2, y, { width: L });
    doc.font("Helvetica").text(field(pairs[1][1]), X2 + L + 6, y);
  }
}

// -------- main --------
export async function createV46Pdf(res, invRaw, frRaw) {
  const inv = invRaw || {};
  const fr = frRaw || {};

  const printed = inv.invoice_number || "";      // pretty
  const norm = inv.invoice_number_norm || "";    // Customer ID
  const custId = inv.customer_code || norm;

  const tyres = asNumber(inv.tyre_count, 4);
  const tyreSize = tyreSizeLabel(inv);

  const qtyMl = asNumber(inv.dosage_ml, 1200);
  const pricePerMl = asNumber(inv.price_per_ml, 4.5);
  const subtotal = asNumber(inv.total_before_gst, Math.round(qtyMl * pricePerMl));
  const gstRate = asNumber(inv.gst_rate, 18);
  const gstAmt = asNumber(inv.gst_amount, Math.round(subtotal * (gstRate / 100)));
  const totalWith = asNumber(inv.total_with_gst, subtotal + gstAmt);

  const vehicle = inv.vehicle_number || "";
  const odometer = inv.odometer != null ? String(inv.odometer) : "";
  const installer = inv.installer_name || "";
  const createdAt = dateIso(inv.created_at);

  const frId = inv.franchisee_id || fr.franchisee_id || fr.code || "";
  const frName = fr.legal_name || fr.name || "";
  const frGstin = fr.gstin || "";
  const frAddr = [fr.address1, fr.address2, fr.city, fr.state, fr.pincode].filter(Boolean).join(", ");

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.pipe(res);

  drawTitle(doc, "MaxTT Billing – Invoice (v46)", 40);

  // Franchisee
  section(doc, "Franchisee", 75);
  kv(doc, 95, [["Franchisee ID", frId], ["Legal Name", frName]]);
  kv(doc, 113, [["GSTIN", frGstin || "—"], ["Address", frAddr || "—"]]);

  // Invoice
  section(doc, "Invoice", 154);
  kv(doc, 174, [["Invoice # (Printed)", printed || "—"], ["Customer ID", custId || "—"]]);
  kv(doc, 192, [["Created At", createdAt], ["", ""]]);

  // Vehicle & Fitment
  section(doc, "Vehicle & Fitment", 233);
  kv(doc, 253, [["Tyre Size", tyreSize || "—"], ["Tyres", String(tyres)]]);
  kv(doc, 271, [["Vehicle #", vehicle || "—"], ["Odometer", odometer || "—"]]);
  kv(doc, 289, [["Installer", installer || "—"], ["", ""]]);

  // Pricing & Taxes
  section(doc, "Pricing & Taxes", 330);
  kv(doc, 350, [["Qty (ml)", qtyMl], ["Price / ml", money(pricePerMl)]]);
  kv(doc, 368, [["Subtotal", money(subtotal)], [`GST @ ${gstRate}%`, money(gstAmt)]]);
  kv(doc, 386, [["Total", money(totalWith)], ["", ""]]);

  // Footer line
  doc.moveTo(50, 740).lineTo(545, 740).strokeColor("#ddd").lineWidth(1).stroke();
  doc.font("Helvetica-Oblique").fontSize(9).fillColor("#444")
    .text(
      "Tyre Size format: width/aspect Rrim when aspect ratio is available; otherwise width Rrim. " +
      "All amounts in Rs. (INR).",
      50, 745, { width: 495 }
    );

  doc.end();
}
