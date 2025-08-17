import express from "express";
import cors from "cors";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://maxtt-billing-frontend.onrender.com";
const API_KEY = process.env.API_KEY || "";          // already used for x-api-key
const MRP_PER_ML = Number(process.env.MRP_PER_ML || "4.5");
const GST_RATE   = Number(process.env.GST_RATE   || "0.18");

// --- Franchisee credentials & profile (SET THESE IN RENDER) ---
const FRANCHISEE_ID       = process.env.FRANCHISEE_ID || "";         // e.g. MAXTT-DEL-001
const FRANCHISEE_PASSWORD = process.env.FRANCHISEE_PASSWORD || "";   // e.g. strong pass
const FR_NAME   = process.env.FRANCHISEE_NAME    || "Franchisee Name";
const FR_ADDR   = process.env.FRANCHISEE_ADDRESS || "Franchisee Address";
const FR_GSTIN  = process.env.FRANCHISEE_GSTIN   || "XXABCDE1234F1Z5";

const app = express();
app.use(express.json());

// CORS locked to your frontend
app.use(cors({ origin: FRONTEND_URL, credentials: false }));
app.options("*", cors({ origin: FRONTEND_URL, credentials: false }));

if (!DATABASE_URL) console.error("Missing DATABASE_URL env var");
const pool = new Pool({ connectionString: DATABASE_URL });

// ============== LOGIN TOKEN STORE (in-memory) =================
const TOKENS = new Map(); // token -> { exp: ms since epoch }
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function issueToken() {
  const token = crypto.randomBytes(24).toString("hex");
  TOKENS.set(token, { exp: Date.now() + TOKEN_TTL_MS });
  return token;
}
function isValidToken(token) {
  const entry = TOKENS.get(token);
  if (!entry) return false;
  if (Date.now() > entry.exp) { TOKENS.delete(token); return false; }
  return true;
}
setInterval(() => { // simple garbage collector
  const now = Date.now();
  for (const [t, { exp }] of TOKENS) if (now > exp) TOKENS.delete(t);
}, 60 * 60 * 1000);

// ================== DB: ensure/migrate ========================
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
      tyre_count INTEGER,
      fitment_locations TEXT,
      customer_gstin TEXT,
      customer_address TEXT
    );
  `);
  console.log("Table ready ✔");
};

const toNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// ======================= ROUTES ===============================
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) => res.send("MaxTT Billing API is running ✔"));

// ---- Login: checks franchisee id/password, issues token
app.post("/api/login", (req, res) => {
  const { id, password } = req.body || {};
  if (!FRANCHISEE_ID || !FRANCHISEE_PASSWORD) {
    return res.status(500).json({ error: "login_not_configured" });
  }
  if (id === FRANCHISEE_ID && password === FRANCHISEE_PASSWORD) {
    const token = issueToken();
    return res.json({ token });
  }
  return res.status(401).json({ error: "invalid_credentials" });
});

// ---- Public: franchisee profile (for invoice header)
app.get("/api/profile", (_req, res) => {
  res.json({
    name: FR_NAME,
    address: FR_ADDR,
    gstin: FR_GSTIN
  });
});

// ---- Middleware: API key + Bearer token for writes
function requireApiKey(req, res, next) {
  if (!API_KEY) {
    console.warn("No API_KEY set; skipping x-api-key check (not recommended).");
    return next();
  }
  const headerKey = req.header("x-api-key");
  const queryKey = req.query.api_key;
  const provided = headerKey || queryKey;
  if (provided && provided === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}
function requireAuth(req, res, next) {
  const auth = req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (!token || !isValidToken(token)) return res.status(401).json({ error: "auth_required" });
  next();
}

// ---- READ: last 20 invoices
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

// ---- READ: one invoice
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

// ---- WRITE: create invoice (needs x-api-key + Bearer)
app.post("/api/invoices", requireApiKey, requireAuth, async (req, res) => {
  try {
    const {
      customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name,
      vehicle_type, tyre_width_mm, aspect_ratio, rim_diameter_in, dosage_ml,
      gps_lat, gps_lng, customer_code, tyre_count,
      fitment_locations, customer_gstin, customer_address
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
      total_with_gst, gst_amount, total_before_gst
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
