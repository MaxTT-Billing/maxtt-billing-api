// pdf/invoice_v46.js (ESM)
// Minimal, robust v46 generator with hardened tyre-size label.
// API: createV46Pdf(res, invRow, franchiseeRow)

import PDFDocument from "pdfkit";

// ---------- helpers ----------
function asNumber(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function money(n) {
  const v = asNumber(n, 0);
  return `₹ ${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
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
  // Hardened rule: width/aspect Rrim when aspect is present & > 0
  return a > 0 ? `${w}/${a} R${r}` : `${w} R${r}`;
}
function textLine(doc, x, y, label, value, opts = {}) {
  const L = opts.labelWidth ?? 140;
  doc.font("Helvetica-Bold").text(label, x, y, { width: L });
  doc.font("Helvetica").text(value ?? "", x + L + 6, y, { width: opts.width ?? 360 });
}
function sectionTitle(doc, text, y) {
  doc.font("Helvetica-Bold").fontSize(12).text(text, 50, y);
  doc.moveTo(50, y + 14).lineTo(545, y + 14).strokeColor("#ddd").stroke();
  doc.fillColor("black").fontSize(10);
}

// ---------- main ----------
export async function createV46Pdf(res, invRaw, frRaw) {
  const inv = invRaw || {};
  const fr = frRaw || {};

  const id = asNumber(inv.id);
  const printed = inv.invoice_number || "";         // e.g., TS-XX-YYY-001/MMYY/#### (pretty)
  const norm = inv.invoice_number_norm || "";       // e.g., TS-XX-YYY-001-#### (our Customer ID)
  const custId = inv.customer_code || norm;

  const tyres = asNumber(inv.tyre_count, 4);
  const width = asNumber(inv.tyre_width_mm);
  const aspect = asNumber(inv.aspect_ratio);
  const rim = asNumber(inv.rim_diameter_in);
  const tyreSize = tyreSizeLabel(inv);              // <- hardened label 195/55 R15

  const pricePerMl = asNumber(inv.price_per_ml, 4.5);
  const qtyMl = asNumber(inv.dosage_ml, 1200);
  const totalBefore = asNumber(inv.total_before_gst, Math.round(qtyMl * pricePerMl));
  const gstAmt = asNumber(inv.gst_amount, Math.round(totalBefore * 0.18));
  const totalWith = asNumber(inv.total_with_gst, totalBefore + gstAmt);
  const gstRate = asNumber(inv.gst_rate, 18);

  const vehicle = String(inv.vehicle_number || "");
  const odometer = inv.odometer != null ? String(inv.odometer) : "";
  const installer = String(inv.installer_name || "");
  const createdAt = dateIso(inv.created_at);

  const frId = String(inv.franchisee_id || fr.franchisee_id || fr.code || "");
  const frName = String(fr.legal_name || fr.name || "");
  const frGstin = String(fr.gstin || "");
  const frAddr = [fr.address1, fr.address2, fr.city, fr.state, fr.pincode]
    .filter(Boolean)
    .join(", ");

  // PDF
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.info.Title = `Invoice ${printed || norm || id}`;
  doc.info.Author = "MaxTT Billing";

  // Pipe to HTTP response
  doc.pipe(res);

  // Header
  doc.font("Helvetica-Bold").fontSize(16).text("MaxTT Billing – Invoice (v46)", 50, 40);
  doc.fontSize(10);

  // Franchisee block
  sectionTitle(doc, "Franchisee", 70);
  textLine(doc, 50, 90, "Franchisee ID", frId);
  textLine(doc, 50, 108, "Legal Name", frName);
  textLine(doc, 50, 126, "GSTIN", frGstin || "—");
  textLine(doc, 50, 144, "Address", frAddr || "—");

  // Invoice block
  sectionTitle(doc, "Invoice", 174);
  textLine(doc, 50, 194, "Invoice # (Printed)", printed || "—");
  textLine(doc, 50, 212, "Customer ID", custId || "—"); // equals invoice_number_norm
  textLine(doc, 50, 230, "Created At", createdAt);

  // Vehicle block
  sectionTitle(doc, "Vehicle & Fitment", 260);
  textLine(doc, 50, 280, "Tyre Size", tyreSize || "—");  // <-- hardened label
  textLine(doc, 50, 298, "Tyres", String(tyres));
  textLine(doc, 50, 316, "Vehicle #", vehicle || "—");
  textLine(doc, 50, 334, "Odometer", odometer || "—");
  textLine(doc, 50, 352, "Installer", installer || "—");

  // Charges block
  sectionTitle(doc, "Pricing & Taxes", 382);
  textLine(doc, 50, 402, "Qty (ml)", String(qtyMl));
  textLine(doc, 50, 420, "Price / ml", money(pricePerMl));
  textLine(doc, 50, 438, "Subtotal", money(totalBefore));
  textLine(doc, 50, 456, `GST @ ${gstRate}%`, money(gstAmt));
  textLine(doc, 50, 474, "Total", money(totalWith));

  // Footer
  doc.moveTo(50, 740).lineTo(545, 740).strokeColor("#ddd").stroke();
  doc.font("Helvetica-Oblique")
    .fillColor("#444")
    .fontSize(9)
    .text(
      "This is a computer-generated invoice. Tyre Size format is strictly \"width/aspect Rrim\" when aspect ratio is present.",
      50,
      745,
      { width: 495 }
    );

  doc.end();
}
