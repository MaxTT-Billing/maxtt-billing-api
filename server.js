import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const MRP_PER_ML = Number(process.env.MRP_PER_ML || "4.5"); // ₹/ml
const GST_RATE = Number(process.env.GST_RATE || "0.18");    // 18%

const app = express();
app.use(express.json());
app.use(cors({ origin: FRONTEND_URL, credentials: false }));

// ----- DB POOL -----
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env var");
}
const pool = new Pool({ connectionString: DATABASE_URL });

// ----- ONE-TIME TABLE CREATE (safe if already exists) -----
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
      customer_code TEXT
    );
  `);
  console.log("Table ready ✔");
};

// ----- HEALTH & ROOT -----
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) => res.send("MaxTT Billing API is running ✔"));

// helper: force numbers (PG returns NUMERIC as strings)
const toNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// ----- LIST LAST 20 INVOICES (force numbers in JS) -----
app.get("/api/invoices", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT
        id, created_at, customer_name, mobile_number, vehicle_number, odometer,
        tread_depth_mm, installer_name, vehicle_type,
        tyre_width_mm, aspect_ratio, rim_diameter_in,
        dosage_ml, price_per_ml, gst_rate,
        total_before_gst, gst_amount, total_with_gst,
        gps_lat, gps_lng, customer_code
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
    }));

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- GET ONE INVOICE BY ID -----
app.get("/api/invoices/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM invoices WHERE id=$1", [req.params.id]);
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
    };
    res.json(cleaned);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- CREATE INVOICE -----
app.post("/api/invoices", async (req, res) => {
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
      dosage_ml,
      gps_lat,
      gps_lng,
      customer_code
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
         total_before_gst, gst_amount, total_with_gst, gps_lat, gps_lng, customer_code)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING id
    `;
    const vals = [
      customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name, vehicle_type,
      tyre_width_mm, aspect_ratio, rim_diameter_in, dosage_ml, price_per_ml, gst_rate,
      total_before_gst, gst_amount, total_with_gst, gps_lat, gps_lng, customer_code
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
