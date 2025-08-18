// server.js
import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";

const MRP_PER_ML = Number(process.env.MRP_PER_ML || "4.5"); // ₹/ml
const GST_RATE   = Number(process.env.GST_RATE   || "0.18"); // 18%

const app = express();
app.use(express.json({ limit: "5mb" })); // allow signature image
app.use(cors({ origin: FRONTEND_URL, credentials: false }));

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env var");
}
const pool = new Pool({
  connectionString: DATABASE_URL,
});

// ----- ONE-TIME TABLE CREATE / MIGRATE -----
const ensureTable = async () => {
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
      dosage_ml NUMERIC,
      price_per_ml NUMERIC,
      gst_rate NUMERIC,
      total_before_gst NUMERIC,
      gst_amount NUMERIC,
      total_with_gst NUMERIC,
      gps_lat NUMERIC,
      gps_lng NUMERIC,
      customer_code TEXT,
      customer_gstin TEXT,
      customer_address TEXT,
      customer_signature TEXT,   -- base64 PNG
      signed_at TIMESTAMP        -- when customer signed/accepted
    );
  `);
  // Light migrations (idempotent)
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tyre_count INTEGER;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fitment_locations TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_gstin TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_address TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_signature TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS signed_at TIMESTAMP;`);
  console.log("Table ready ✔");
};

// ----- HEALTH CHECK -----
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// ----- SIMPLE AUTH (Franchisee) -----
import crypto from "crypto";
const API_KEY = process.env.API_KEY || ""; // header x-api-key for write ops

// very basic mock login used earlier (keep same to avoid breaking)
const FRANCHISEE = {
  id: process.env.FRANCHISEE_ID || "fr001",
  password: process.env.FRANCHISEE_PASSWORD || "pass123",
  name: process.env.FRANCHISEE_NAME || "MaxTT Franchisee",
  gstin: process.env.FRANCHISEE_GSTIN || "29ABCDE1234F1Z5",
  address: process.env.FRANCHISEE_ADDRESS || "Main Road, Gurgaon, Haryana, India",
  franchisee_id: process.env.FRANCHISEE_ID || "fr001",
};

function signToken(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHash("sha256").update(payload + (process.env.API_KEY || "")).digest("hex");
  return `${payload}.${sig}`;
}
function verifyToken(tok) {
  if (!tok) return null;
  const [p, s] = tok.split(".");
  const sig = crypto.createHash("sha256").update(p + (process.env.API_KEY || "")).digest("hex");
  if (sig !== s) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
}

app.post("/api/login", async (req, res) => {
  const { id, password } = req.body || {};
  if (id === FRANCHISEE.id && password === FRANCHISEE.password) {
    const token = signToken({ id, role: "franchisee" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "invalid_credentials" });
});

app.get("/api/profile", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const who = verifyToken(token);
  if (!who) return res.status(401).json({ error: "unauthorized" });
  res.json({
    name: FRANCHISEE.name,
    gstin: FRANCHISEE.gstin,
    address: FRANCHISEE.address,
    franchisee_id: FRANCHISEE.franchisee_id
  });
});

// ----- LIST / FILTER INVOICES -----
app.get("/api/invoices", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const who = verifyToken(token);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  const { q, from, to, limit = 500 } = req.query;
  const params = [];
  let where = [];
  if (q) {
    params.push(`%${q}%`);
    params.push(`%${q}%`);
    where.push(`(customer_name ILIKE $${params.length - 1} OR vehicle_number ILIKE $${params.length})`);
  }
  if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
  if (to)   { params.push(to + " 23:59:59"); where.push(`created_at <= $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT * FROM invoices
    ${w}
    ORDER BY created_at DESC
    LIMIT ${Number(limit) || 500}
  `;
  try {
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- SUMMARY -----
app.get("/api/summary", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const who = verifyToken(token);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  const { q, from, to } = req.query;
  const params = [];
  let where = [];
  if (q) {
    params.push(`%${q}%`);
    params.push(`%${q}%`);
    where.push(`(customer_name ILIKE $${params.length - 1} OR vehicle_number ILIKE $${params.length})`);
  }
  if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
  if (to)   { params.push(to + " 23:59:59"); where.push(`created_at <= $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT
      COUNT(*)::int AS count,
      COALESCE(SUM(dosage_ml),0)::numeric AS dosage_ml,
      COALESCE(SUM(total_before_gst),0)::numeric AS total_before_gst,
      COALESCE(SUM(gst_amount),0)::numeric AS gst_amount,
      COALESCE(SUM(total_with_gst),0)::numeric AS total_with_gst
    FROM invoices
    ${w}
  `;
  try {
    const r = await pool.query(sql, params);
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- GET ONE -----
app.get("/api/invoices/:id", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const who = verifyToken(token);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  try {
    const r = await pool.query("SELECT * FROM invoices WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- CREATE -----
// Requires x-api-key header for write (simple guard)
app.post("/api/invoices", async (req, res) => {
  if ((req.headers["x-api-key"] || "") !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const who = verifyToken(token);
  if (!who) return res.status(401).json({ error: "unauthorized" });

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
      tyre_count,
      fitment_locations,
      dosage_ml,
      gps_lat,
      gps_lng,
      customer_code,
      customer_gstin,
      customer_address,
      customer_signature, // base64 data URL ("data:image/png;base64,...")
      signed_at
    } = req.body || {};

    if (!customer_name || !vehicle_number || !dosage_ml) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const total_before_gst = Number(dosage_ml) * MRP_PER_ML;
    const gst_amount = total_before_gst * GST_RATE;
    const total_with_gst = total_before_gst + gst_amount;

    const q = `
      INSERT INTO invoices
        (customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name, vehicle_type,
         tyre_width_mm, aspect_ratio, rim_diameter_in, tyre_count, fitment_locations,
         dosage_ml, price_per_ml, gst_rate, total_before_gst, gst_amount, total_with_gst,
         gps_lat, gps_lng, customer_code, customer_gstin, customer_address, customer_signature, signed_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,
         $8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24,$25,NOW())
      RETURNING id
    `;
    const vals = [
      customer_name, mobile_number, vehicle_number, odometer ?? null, tread_depth_mm ?? null, installer_name, vehicle_type,
      tyre_width_mm ?? null, aspect_ratio ?? null, rim_diameter_in ?? null, tyre_count ?? null, fitment_locations || null,
      dosage_ml, MRP_PER_ML, GST_RATE, total_before_gst, gst_amount, total_with_gst,
      gps_lat ?? null, gps_lng ?? null, customer_code || null, customer_gstin || null, customer_address || null,
      customer_signature || null, signed_at ? new Date(signed_at) : new Date()
    ];
    const r = await pool.query(q, vals);
    res.status(201).json({ id: r.rows[0].id, total_with_gst, gst_amount, total_before_gst });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- UPDATE (for edits) -----
app.put("/api/invoices/:id", async (req, res) => {
  if ((req.headers["x-api-key"] || "") !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const who = verifyToken(token);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  try {
    const b = req.body || {};
    // Recompute totals if dosage changes
    let dosage_ml = b.dosage_ml;
    let total_before_gst = b.total_before_gst;
    let gst_amount = b.gst_amount;
    let total_with_gst = b.total_with_gst;
    if (typeof dosage_ml !== "undefined") {
      total_before_gst = Number(dosage_ml) * MRP_PER_ML;
      gst_amount = total_before_gst * GST_RATE;
      total_with_gst = total_before_gst + gst_amount;
    }

    const fields = [
      "customer_name","mobile_number","vehicle_number","odometer","tread_depth_mm","installer_name","vehicle_type",
      "tyre_width_mm","aspect_ratio","rim_diameter_in","tyre_count","fitment_locations",
      "dosage_ml","customer_gstin","customer_address","customer_signature","signed_at"
    ];
    const sets = [];
    const vals = [];
    let idx = 1;
    for (const f of fields) {
      if (f in b) { sets.push(`${f} = $${idx++}`); vals.push(b[f]); }
    }
    if (typeof dosage_ml !== "undefined") {
      sets.push(`price_per_ml = $${idx++}`); vals.push(MRP_PER_ML);
      sets.push(`gst_rate = $${idx++}`); vals.push(GST_RATE);
      sets.push(`total_before_gst = $${idx++}`); vals.push(total_before_gst);
      sets.push(`gst_amount = $${idx++}`); vals.push(gst_amount);
      sets.push(`total_with_gst = $${idx++}`); vals.push(total_with_gst);
    }
    sets.push(`updated_at = NOW()`);

    const sql = `UPDATE invoices SET ${sets.join(", ")} WHERE id=$${idx} RETURNING *`;
    vals.push(req.params.id);

    const r = await pool.query(sql, vals);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----- EXPORT CSV -----
app.get("/api/invoices/export", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const who = verifyToken(token);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  try {
    const r = await pool.query(`
      SELECT id, created_at, customer_name, vehicle_number, vehicle_type, tyre_count, dosage_ml,
             total_before_gst, gst_amount, total_with_gst
      FROM invoices
      ORDER BY created_at DESC
      LIMIT 1000
    `);
    const rows = r.rows || [];
    const header = "id,created_at,customer_name,vehicle_number,vehicle_type,tyre_count,dosage_ml,total_before_gst,gst_amount,total_with_gst\n";
    const csv = header + rows.map(o =>
      [o.id, o.created_at?.toISOString?.() || o.created_at, o.customer_name, o.vehicle_number, o.vehicle_type, o.tyre_count, o.dosage_ml, o.total_before_gst, o.gst_amount, o.total_with_gst]
        .map(v => `"${String(v ?? "").replace(/"/g,'""')}"`).join(",")
    ).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=invoices_export.csv");
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.listen(PORT, async () => {
  await ensureTable();
  console.log(`API listening on ${PORT}`);
});
