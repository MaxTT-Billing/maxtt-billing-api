import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://maxtt-billing-frontend.onrender.com";
const API_KEY = process.env.API_KEY || ""; // set this in Render
const MRP_PER_ML = Number(process.env.MRP_PER_ML || "4.5"); // ₹/ml
const GST_RATE = Number(process.env.GST_RATE || "0.18");    // 18%

const app = express();
app.use(express.json());

// CORS locked to your site
app.use(cors({ origin: FRONTEND_URL, credentials: false }));
app.options("*", cors({ origin: FRONTEND_URL, credentials: false }));

if (!DATABASE_URL) console.error("Missing DATABASE_URL env var");
const pool = new Pool({ connectionString: DATABASE_URL });

// ----- ONE-TIME TABLE CREATE / MIGRATE -----
const ensureTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      customer_name TEXT,
      mobile_number TEXT,
      vehicle_number TEXT,
      odometer INTEGER,
      tread_depth_mm NUMERIC,
      installer_name TEXT,
      vehicle_type TEXT,
      tyre_width_mm NUMERIC,
      aspect_ratio NUMERIC,
      rim_diameter_in NUMERIC,
      dosage_ml NUMERIC,
      price_per_ml NUMERIC,
      gst_rate NUMERIC,
      total_before_gst NUMERIC,
      gst_amount NUMERIC,
      total_with_gst NUMERIC,
      gps_lat NUMERIC,
      gps_lng NUMERIC,
      customer_code TEXT,
      tyre_count INTEGER
    );
  `);
  // New fields
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fitment_locations TEXT;`); // e.g. "Front Left, Front Right, Rear Left, Rear Right"
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_gstin TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_address TEXT;`);
  console.log("Table ready ✔ (with tyre_count, fitment_locations, customer_gstin, customer_address)");
};

// helpers
const toNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// health & root
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) => res.send("MaxTT Billing API is running ✔"));

// Simple API key guard for write endpoints
function requireApiKey(req, res, next) {
  const headerKey = req.header("x-api-key");
  const queryKey = req.query.api_key;
  const provided = headerKey || queryKey;
  if (!API_KEY) {
    console.warn("No API_KEY set on server; skipping auth (not recommended).");
    return next();
  }
  if (provided && provided === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ----- READ: last 20 invoices -----
app.get("/api/invoices", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT
         id, created_at, customer_name, mobile_number, vehicle_number, odometer,
         tread_depth_mm, installer_name, vehicle_type,
         tyre_width_mm, aspect_ratio, rim_diameter_in,
         dosage_ml, price_per_ml, gst_rate,
         total_before_gst, gst_amount, total_with_gst,
         gps_lat, gps_lng, customer_code, tyre_count,
         fitment_locations, customer_gstin, customer_address
       FROM invoices
       ORDER BY created_at DESC
       LIMIT 20`
    );
    const rows = r.rows.map(row => ({
      ...row,
      tread_depth_mm: toNum(row.tread_depth_mm),
      tyre_width_mm: toNum(row.tyre_width_mm),
      aspect_ratio: toNum(row.aspect_ratio),
      rim_diameter_in: toNum(row.rim_diameter_in),
      dosage_ml: toNum(row.dosage_ml),
      price_per_ml: toNum(row.price_per_ml),
      gst_rate: toNum(row.gst_rate),
      total_before_gst: toNum(row.total_before_gst),
      gst_amount: toNum(row.gst_amount),
      total_with_gst: toNum(row.total_with_gst),
      gps_lat: toNum(row.gps_lat),
      gps_lng: toNum(row.gps_lng),
      tyre_count: row.tyre_count == null ? null : Number(row.tyre_count)
    }));
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- READ: one invoice -----
app.get("/api/invoices/:id", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
         id, created_at, customer_name, mobile_number, vehicle_number, odometer,
         tread_depth_mm, installer_name, vehicle_type,
         tyre_width_mm, aspect_ratio, rim_diameter_in,
         dosage_ml, price_per_ml, gst_rate,
         total_before_gst, gst_amount, total_with_gst,
         gps_lat, gps_lng, customer_code, tyre_count,
         fitment_locations, customer_gstin, customer_address
       FROM invoices WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    const row = r.rows[0];
    const cleaned = {
      ...row,
      tread_depth_mm: toNum(row.tread_depth_mm),
      tyre_width_mm: toNum(row.tyre_width_mm),
      aspect_ratio: toNum(row.aspect_ratio),
      rim_diameter_in: toNum(row.rim_diameter_in),
      dosage_ml: toNum(row.dosage_ml),
      price_per_ml: toNum(row.price_per_ml),
      gst_rate: toNum(row.gst_rate),
      total_before_gst: toNum(row.total_before_gst),
      gst_amount: toNum(row.gst_amount),
      total_with_gst: toNum(row.total_with_gst),
      gps_lat: toNum(row.gps_lat),
      gps_lng: toNum(row.gps_lng),
      tyre_count: row.tyre_count == null ? null : Number(row.tyre_count)
    };
    res.json(cleaned);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- WRITE: create invoice (protected) -----
app.post("/api/invoices", requireApiKey, async (req, res) => {
  try {
    const {
      customer_name,
      mobile_number,
      vehicle_number,
      odometer,
      tread_depth_mm,
      installer_name,
      vehicle_type,
      tyre_width_mm,
      aspect_ratio,
      rim_diameter_in,
      dosage_ml,   // TOTAL dosage
      gps_lat,
      gps_lng,
      customer_code,
      tyre_count,
      fitment_locations, // NEW text (e.g. "Front Left, Front Right")
      customer_gstin,    // NEW
      customer_address   // NEW
    } = req.body || {};

    if (!customer_name || !vehicle_number || !dosage_ml) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const price_per_ml = MRP_PER_ML;
    const gst_rate = GST_RATE;

    const total_before_gst = Number(dosage_ml) * price_per_ml;
    const gst_amount = total_before_gst * gst_rate;
    const total_with_gst = total_before_gst + gst_amount;

    const q = `
      INSERT INTO invoices
        (customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name, vehicle_type,
         tyre_width_mm, aspect_ratio, rim_diameter_in, dosage_ml, price_per_ml, gst_rate,
         total_before_gst, gst_amount, total_with_gst, gps_lat, gps_lng, customer_code, tyre_count,
         fitment_locations, customer_gstin, customer_address)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      RETURNING id
    `;
    const vals = [
      customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name, vehicle_type,
      tyre_width_mm, aspect_ratio, rim_diameter_in, dosage_ml, price_per_ml, gst_rate,
      total_before_gst, gst_amount, total_with_gst, gps_lat, gps_lng, customer_code, tyre_count,
      fitment_locations || null, customer_gstin || null, customer_address || null
    ];
    const r = await pool.query(q, vals);

    res.status(201).json({
      id: r.rows[0].id,
      total_with_gst,
      gst_amount,
      total_before_gst
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.listen(PORT, async () => {
  await ensureTable();
  console.log(`API listening on ${PORT}`);
});
