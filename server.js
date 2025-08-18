import express from "express";
import cors from "cors";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

// Allow only your frontend
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://maxtt-billing-frontend.onrender.com";

// Commercial settings
const MRP_PER_ML = Number(process.env.MRP_PER_ML || "4.5");
const GST_RATE = Number(process.env.GST_RATE || "0.18");

// Extra protection for create/update routes
const API_KEY = process.env.API_KEY || "";

// Seed one franchisee from env (you can add more later via SQL)
const SEED_CODE = process.env.FRANCHISEE_ID || "";
const SEED_PASS = process.env.FRANCHISEE_PASSWORD || "";
const SEED_NAME = process.env.FRANCHISEE_NAME || "Franchisee Name";
const SEED_ADDR = process.env.FRANCHISEE_ADDRESS || "FULL POSTAL ADDRESS AS PER GSTIN CERTIFICATE";
const SEED_GSTIN = process.env.FRANCHISEE_GSTIN || "AS PER GSTIN CERTIFICATE";

const app = express();
app.use(express.json());
app.use(cors({ origin: FRONTEND_URL, credentials: false }));
app.options("*", cors({ origin: FRONTEND_URL, credentials: false }));

if (!DATABASE_URL) console.error("Missing DATABASE_URL");
const pool = new Pool({ connectionString: DATABASE_URL });

// -------------------- TOKEN STORE (in-memory) --------------------
const TOKENS = new Map(); // token -> { exp, code }
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function issueToken(code) {
  const token = crypto.randomBytes(24).toString("hex");
  TOKENS.set(token, { exp: Date.now() + TOKEN_TTL_MS, code });
  return token;
}
function readToken(token) {
  const rec = TOKENS.get(token);
  if (!rec) return null;
  if (Date.now() > rec.exp) {
    TOKENS.delete(token);
    return null;
  }
  return rec;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, { exp }] of TOKENS) if (now > exp) TOKENS.delete(t);
}, 60 * 60 * 1000);

// -------------------- DB ENSURE + AUTO-MIGRATIONS --------------------
const ensureTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS franchisees (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      address TEXT,
      gstin TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  if (SEED_CODE && SEED_PASS) {
    await pool.query(
      `INSERT INTO franchisees (code, password, name, address, gstin, is_active)
       VALUES ($1,$2,$3,$4,$5,TRUE)
       ON CONFLICT (code) DO UPDATE
       SET password=EXCLUDED.password,
           name=EXCLUDED.name,
           address=EXCLUDED.address,
           gstin=EXCLUDED.gstin,
           is_active=TRUE`,
      [SEED_CODE, SEED_PASS, SEED_NAME, SEED_ADDR, SEED_GSTIN]
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
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
      tyre_count INTEGER,
      fitment_locations TEXT,
      customer_gstin TEXT,
      customer_address TEXT,
      dosage_ml NUMERIC,
      price_per_ml NUMERIC,
      gst_rate NUMERIC,
      total_before_gst NUMERIC,
      gst_amount NUMERIC,
      total_with_gst NUMERIC,
      gps_lat NUMERIC,
      gps_lng NUMERIC,
      customer_code TEXT,
      franchisee_id TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_edits (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      edited_at TIMESTAMP DEFAULT NOW(),
      snapshot JSONB NOT NULL
    );
  `);

  // --- Add missing columns safely for older DBs ---
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS franchisee_id TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tyre_count INTEGER;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fitment_locations TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_gstin TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_address TEXT;`);
};

const toNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// -------------------- MIDDLEWARE --------------------
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // if not set, skip (MVP)
  const provided = req.header("x-api-key") || req.query.api_key;
  if (provided && provided === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}
function requireAuth(req, res, next) {
  const auth = req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  const rec = token ? readToken(token) : null;
  if (!rec) return res.status(401).json({ error: "auth_required" });
  req.franchiseeCode = rec.code;
  next();
}
async function getFranchiseeByCode(code) {
  const r = await pool.query(`SELECT code, name, address, gstin, is_active FROM franchisees WHERE code=$1`, [code]);
  return r.rows[0] || null;
}

// -------------------- ROUTES --------------------
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) => res.send("MaxTT Billing API is running ✔"));

// Login → returns token
app.post("/api/login", async (req, res) => {
  const { id, password } = req.body || {};
  if (!id || !password) return res.status(400).json({ error: "missing_credentials" });
  const r = await pool.query(`SELECT code, password, is_active FROM franchisees WHERE code=$1`, [id]);
  if (!r.rows.length) return res.status(401).json({ error: "invalid_credentials" });
  const row = r.rows[0];
  if (!row.is_active || row.password !== password) return res.status(401).json({ error: "invalid_credentials" });
  const token = issueToken(row.code);
  res.json({ token });
});

// Franchisee profile (for header)
app.get("/api/profile", requireAuth, async (req, res) => {
  const fr = await getFranchiseeByCode(req.franchiseeCode);
  if (!fr) return res.status(404).json({ error: "franchisee_not_found" });
  res.json({ franchisee_id: fr.code, name: fr.name, address: fr.address, gstin: fr.gstin });
});

// List/search invoices
app.get("/api/invoices", requireAuth, async (req, res) => {
  try {
    const { q, from, to, limit } = req.query;
    const where = [`franchisee_id = $1`];
    const params = [req.franchiseeCode];
    let idx = 2;

    if (q) { where.push(`(customer_name ILIKE $${idx} OR vehicle_number ILIKE $${idx})`); params.push(`%${q}%`); idx++; }
    if (from) { where.push(`created_at >= $${idx}`); params.push(from + " 00:00:00"); idx++; }
    if (to)   { where.push(`created_at <  $${idx}`); params.push(to + " 23:59:59"); idx++; }

    const lim = Math.min(parseInt(limit || "500", 10), 1000);

    const r = await pool.query(
      `SELECT
         id, created_at, updated_at,
         customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name,
         vehicle_type, tyre_width_mm, aspect_ratio, rim_diameter_in, tyre_count, fitment_locations,
         customer_gstin, customer_address,
         dosage_ml, price_per_ml, gst_rate, total_before_gst, gst_amount, total_with_gst,
         gps_lat, gps_lng, customer_code, franchisee_id
       FROM invoices
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ${lim}`, params
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

// Get one invoice
app.get("/api/invoices/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM invoices WHERE id=$1 AND franchisee_id=$2`,
      [req.params.id, req.franchiseeCode]
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

// Create invoice
app.post("/api/invoices", requireApiKey, requireAuth, async (req, res) => {
  try {
    const {
      customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name,
      vehicle_type, tyre_width_mm, aspect_ratio, rim_diameter_in, tyre_count,
      fitment_locations, customer_gstin, customer_address,
      dosage_ml, gps_lat, gps_lng, customer_code
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
        (customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name,
         vehicle_type, tyre_width_mm, aspect_ratio, rim_diameter_in, tyre_count, fitment_locations,
         customer_gstin, customer_address,
         dosage_ml, price_per_ml, gst_rate, total_before_gst, gst_amount, total_with_gst,
         gps_lat, gps_lng, customer_code, franchisee_id)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      RETURNING id
    `;
    const vals = [
      customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name,
      vehicle_type, tyre_width_mm, aspect_ratio, rim_diameter_in, tyre_count, fitment_locations || null,
      customer_gstin || null, customer_address || null,
      dosage_ml, price_per_ml, gst_rate, total_before_gst, gst_amount, total_with_gst,
      gps_lat, gps_lng, customer_code, req.franchiseeCode
    ];
    const r = await pool.query(q, vals);
    res.status(201).json({ id: r.rows[0].id, total_with_gst, gst_amount, total_before_gst });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Edit invoice (keeps snapshot)
app.put("/api/invoices/:id", requireApiKey, requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query(
      `SELECT * FROM invoices WHERE id=$1 AND franchisee_id=$2`,
      [id, req.franchiseeCode]
    );
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });

    // snapshot before update
    await pool.query(
      `INSERT INTO invoice_edits (invoice_id, snapshot) VALUES ($1, $2)`,
      [id, JSON.stringify(existing.rows[0])]
    );

    const {
      customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name,
      vehicle_type, tyre_width_mm, aspect_ratio, rim_diameter_in, tyre_count,
      fitment_locations, customer_gstin, customer_address,
      dosage_ml, gps_lat, gps_lng, customer_code
    } = req.body || {};

    const useDosage = dosage_ml != null ? Number(dosage_ml) : Number(existing.rows[0].dosage_ml);
    const price_per_ml = MRP_PER_ML;
    const gst_rate = GST_RATE;
    const total_before_gst = useDosage * price_per_ml;
    const gst_amount = total_before_gst * gst_rate;
    const total_with_gst = total_before_gst + gst_amount;

    const q = `
      UPDATE invoices SET
        customer_name = COALESCE($1, customer_name),
        mobile_number = COALESCE($2, mobile_number),
        vehicle_number = COALESCE($3, vehicle_number),
        odometer = COALESCE($4, odometer),
        tread_depth_mm = COALESCE($5, tread_depth_mm),
        installer_name = COALESCE($6, installer_name),
        vehicle_type = COALESCE($7, vehicle_type),
        tyre_width_mm = COALESCE($8, tyre_width_mm),
        aspect_ratio = COALESCE($9, aspect_ratio),
        rim_diameter_in = COALESCE($10, rim_diameter_in),
        tyre_count = COALESCE($11, tyre_count),
        fitment_locations = COALESCE($12, fitment_locations),
        customer_gstin = COALESCE($13, customer_gstin),
        customer_address = COALESCE($14, customer_address),
        dosage_ml = $15,
        price_per_ml = $16,
        gst_rate = $17,
        total_before_gst = $18,
        gst_amount = $19,
        total_with_gst = $20,
        gps_lat = COALESCE($21, gps_lat),
        gps_lng = COALESCE($22, gps_lng),
        customer_code = COALESCE($23, customer_code),
        updated_at = NOW()
      WHERE id=$24 AND franchisee_id=$25
      RETURNING id
    `;
    const vals = [
      customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name,
      vehicle_type, tyre_width_mm, aspect_ratio, rim_diameter_in, tyre_count,
      fitment_locations || null, customer_gstin || null, customer_address || null,
      useDosage, price_per_ml, gst_rate, total_before_gst, gst_amount, total_with_gst,
      gps_lat, gps_lng, customer_code, id, req.franchiseeCode
    ];
    const r = await pool.query(q, vals);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Summary
app.get("/api/summary", requireAuth, async (req, res) => {
  try {
    const { q, from, to } = req.query;
    const where = [`franchisee_id = $1`];
    const params = [req.franchiseeCode];
    let idx = 2;

    if (q) { where.push(`(customer_name ILIKE $${idx} OR vehicle_number ILIKE $${idx})`); params.push(`%${q}%`); idx++; }
    if (from) { where.push(`created_at >= $${idx}`); params.push(from + " 00:00:00"); idx++; }
    if (to)   { where.push(`created_at <  $${idx}`); params.push(to + " 23:59:59"); idx++; }

    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS count,
         COALESCE(SUM(dosage_ml),0)::float AS dosage_ml,
         COALESCE(SUM(total_before_gst),0)::float AS total_before_gst,
         COALESCE(SUM(gst_amount),0)::float AS gst_amount,
         COALESCE(SUM(total_with_gst),0)::float AS total_with_gst
       FROM invoices WHERE ${where.join(" AND ")}`, params
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// CSV Export
app.get("/api/invoices/export", requireAuth, async (req, res) => {
  try {
    const { q, from, to } = req.query;
    const where = [`franchisee_id = $1`];
    const params = [req.franchiseeCode];
    let idx = 2;

    if (q) { where.push(`(customer_name ILIKE $${idx} OR vehicle_number ILIKE $${idx})`); params.push(`%${q}%`); idx++; }
    if (from) { where.push(`created_at >= $${idx}`); params.push(from + " 00:00:00"); idx++; }
    if (to)   { where.push(`created_at <  $${idx}`); params.push(to + " 23:59:59"); idx++; }

    const r = await pool.query(
      `SELECT id, created_at, customer_name, mobile_number, vehicle_number, vehicle_type,
              tyre_count, fitment_locations, tyre_width_mm, aspect_ratio, rim_diameter_in,
              tread_depth_mm, dosage_ml, price_per_ml, gst_rate,
              total_before_gst, gst_amount, total_with_gst,
              customer_gstin, customer_address
       FROM invoices
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC`, params
    );

    const rows = r.rows;
    const header = [
      "id","created_at","customer_name","mobile_number","vehicle_number","vehicle_type",
      "tyre_count","fitment_locations","tyre_width_mm","aspect_ratio","rim_diameter_in",
      "tread_depth_mm","dosage_ml","price_per_ml","gst_rate",
      "total_before_gst","gst_amount","total_with_gst",
      "customer_gstin","customer_address"
    ];
    const escape = (v) => {
      const s = v == null ? "" : String(v);
      if (s.includes(",") || s.includes("\n") || s.includes("\"")) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [header.join(",")];
    for (const row of rows) lines.push(header.map(h => escape(row[h])).join(","));
    const csv = lines.join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="invoices_export.csv"`);
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.listen(PORT, async () => {
  await ensureTables();
  console.log(`API listening on ${PORT}`);
});
