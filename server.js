// server.js (MaxTT Billing API – Phase 2.0 + 2.1 groundwork)
import express from "express";
import cors from "cors";
import crypto from "crypto";
import pkg from "pg";
const { Pool } = pkg;

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";

const MRP_PER_ML = Number(process.env.MRP_PER_ML || "4.5");
const GST_RATE   = Number(process.env.GST_RATE   || "0.18");
const API_KEY    = process.env.API_KEY || "";

// Franchisee profile (as before)
const FRANCHISEE = {
  id:        process.env.FRANCHISEE_ID || "fr001",
  password:  process.env.FRANCHISEE_PASSWORD || "pass123",
  name:      process.env.FRANCHISEE_NAME || "MaxTT Franchisee",
  gstin:     process.env.FRANCHISEE_GSTIN || "29ABCDE1234F1Z5",
  address:   process.env.FRANCHISEE_ADDRESS || "Main Road, Gurgaon, Haryana, India",
  franchisee_id: process.env.FRANCHISEE_ID || "fr001",
};

// Admin / Super Admin credentials (new)
const ADMIN = {
  id:       process.env.ADMIN_ID || "admin",
  password: process.env.ADMIN_PASSWORD || "adminpass",
  role:     "admin",
};
const SA = {
  id:       process.env.SA_ID || "superadmin",
  password: process.env.SA_PASSWORD || "sapass",
  role:     "super_admin",
};

const app = express();
app.use(express.json({ limit: "6mb" })); // allow base64 signatures
app.use(cors({ origin: FRONTEND_URL, credentials: false }));

if (!DATABASE_URL) console.error("Missing DATABASE_URL");
const pool = new Pool({ connectionString: DATABASE_URL });

// ---------- DB: ensure/migrate ----------
async function ensureTables() {
  // invoices (extend with consent/final snapshots & signatures)
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

      -- FINAL invoice signature (already used earlier)
      customer_signature TEXT,
      signed_at TIMESTAMP,
      declaration_snapshot TEXT,   -- new: snapshot of final declaration text used

      -- MID-WAY consent (new)
      consent_signature TEXT,
      consent_signed_at TIMESTAMP,
      consent_snapshot TEXT        -- snapshot of consent text used
    );
  `);

  // audit log (new)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMP DEFAULT NOW(),
      actor_role TEXT,
      actor_id TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      ip TEXT,
      user_agent TEXT,
      details_json TEXT
    );
  `);

  // dispute tickets (new)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispute_tickets (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
      reason TEXT,
      status TEXT DEFAULT 'open', -- open, approved, rejected, closed
      created_by TEXT,
      created_role TEXT,
      approved_by TEXT,
      approved_at TIMESTAMP
    );
  `);

  // Migrations (idempotent guards)
  const alters = [
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tyre_count INTEGER;`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fitment_locations TEXT;`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_gstin TEXT;`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_address TEXT;`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS consent_signature TEXT;`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS consent_signed_at TIMESTAMP;`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS consent_snapshot TEXT;`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS declaration_snapshot TEXT;`
  ];
  for (const sql of alters) { try { await pool.query(sql); } catch {} }

  console.log("DB ready ✔");
}

// ---------- auth helpers ----------
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
function whoami(req) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return verifyToken(token);
}

// ---------- audit ----------
async function audit({ req, actor, action, entity_type, entity_id, details }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_role, actor_id, action, entity_type, entity_id, ip, user_agent, details_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        actor?.role || null,
        actor?.id || null,
        action || null,
        entity_type || null,
        entity_id || null,
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
        details ? JSON.stringify(details) : null
      ]
    );
  } catch (e) { console.error("audit error", e.message); }
}

// ---------- health ----------
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// ---------- logins ----------
app.post("/api/login", (req, res) => {
  const { id, password } = req.body || {};
  if (id === FRANCHISEE.id && password === FRANCHISEE.password) {
    const token = signToken({ id, role: "franchisee" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "invalid_credentials" });
});
app.post("/api/admin/login", (req, res) => {
  const { id, password } = req.body || {};
  if (id === ADMIN.id && password === ADMIN.password) {
    const token = signToken({ id, role: "admin" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "invalid_credentials" });
});
app.post("/api/sa/login", (req, res) => {
  const { id, password } = req.body || {};
  if (id === SA.id && password === SA.password) {
    const token = signToken({ id, role: "super_admin" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "invalid_credentials" });
});

app.get("/api/profile", (req, res) => {
  const me = whoami(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });
  if (me.role === "franchisee") {
    return res.json({
      name: FRANCHISEE.name,
      gstin: FRANCHISEE.gstin,
      address: FRANCHISEE.address,
      franchisee_id: FRANCHISEE.franchisee_id
    });
  }
  // simple admin/sa echo
  return res.json({ id: me.id, role: me.role });
});

// ---------- invoices: list/filter ----------
app.get("/api/invoices", async (req, res) => {
  const me = whoami(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });

  const { q, from, to, limit = 500 } = req.query;
  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q}%`); params.push(`%${q}%`);
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

// ---------- invoices: summary ----------
app.get("/api/summary", async (req, res) => {
  const me = whoami(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });

  const { q, from, to } = req.query;
  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q}%`); params.push(`%${q}%`);
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

// ---------- invoices: get one ----------
app.get("/api/invoices/:id", async (req, res) => {
  const me = whoami(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });

  try {
    const r = await pool.query("SELECT * FROM invoices WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ---------- invoices: create ----------
app.post("/api/invoices", async (req, res) => {
  if ((req.headers["x-api-key"] || "") !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  const me = whoami(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });

  try {
    const b = req.body || {};
    const required = ["customer_name","vehicle_number","dosage_ml"];
    for (const k of required) if (!b[k]) return res.status(400).json({ error: "missing_fields" });

    const total_before_gst = Number(b.dosage_ml) * MRP_PER_ML;
    const gst_amount = total_before_gst * GST_RATE;
    const total_with_gst = total_before_gst + gst_amount;

    const q = `
      INSERT INTO invoices (
        customer_name, mobile_number, vehicle_number, odometer, tread_depth_mm, installer_name,
        vehicle_type, tyre_width_mm, aspect_ratio, rim_diameter_in, tyre_count, fitment_locations,
        dosage_ml, price_per_ml, gst_rate, total_before_gst, gst_amount, total_with_gst,
        gps_lat, gps_lng, customer_code, customer_gstin, customer_address,
        consent_signature, consent_signed_at, consent_snapshot,
        customer_signature, signed_at, declaration_snapshot,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,
        $24,$25,$26,
        $27,$28,$29,
        NOW()
      )
      RETURNING id
    `;
    const vals = [
      b.customer_name, b.mobile_number || null, b.vehicle_number, b.odometer ?? null, b.tread_depth_mm ?? null, b.installer_name || null,
      b.vehicle_type, b.tyre_width_mm ?? null, b.aspect_ratio ?? null, b.rim_diameter_in ?? null, b.tyre_count ?? null, b.fitment_locations || null,
      b.dosage_ml, MRP_PER_ML, GST_RATE, total_before_gst, gst_amount, total_with_gst,
      b.gps_lat ?? null, b.gps_lng ?? null, b.customer_code || null, b.customer_gstin || null, b.customer_address || null,
      b.consent_signature || null, b.consent_signed_at ? new Date(b.consent_signed_at) : null, b.consent_snapshot || null,
      b.customer_signature || null, b.signed_at ? new Date(b.signed_at) : null, b.declaration_snapshot || null
    ];
    const r = await pool.query(q, vals);

    await audit({
      req, actor: me, action: "invoice_create", entity_type: "invoice", entity_id: r.rows[0].id,
      details: { total_with_gst, dosage_ml: b.dosage_ml }
    });

    res.status(201).json({ id: r.rows[0].id, total_before_gst, gst_amount, total_with_gst });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ---------- invoices: update ----------
app.put("/api/invoices/:id", async (req, res) => {
  if ((req.headers["x-api-key"] || "") !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  const me = whoami(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });

  try {
    const b = req.body || {};
    // If dosage changes, recompute totals
    let dosage_ml = b.dosage_ml;
    let total_before_gst, gst_amount, total_with_gst;
    const sets = [];
    const vals = [];
    let i = 1;

    const fields = [
      "customer_name","mobile_number","vehicle_number","odometer","tread_depth_mm","installer_name",
      "vehicle_type","tyre_width_mm","aspect_ratio","rim_diameter_in","tyre_count","fitment_locations",
      "customer_gstin","customer_address",
      "consent_signature","consent_signed_at","consent_snapshot",
      "customer_signature","signed_at","declaration_snapshot",
      "dosage_ml"
    ];
    for (const f of fields) {
      if (f in b) {
        sets.push(`${f} = $${i++}`);
        vals.push(f === "consent_signed_at" || f === "signed_at" ? (b[f] ? new Date(b[f]) : null) : b[f]);
      }
    }
    if (typeof dosage_ml !== "undefined") {
      total_before_gst = Number(dosage_ml) * MRP_PER_ML;
      gst_amount = total_before_gst * GST_RATE;
      total_with_gst = total_before_gst + gst_amount;
      sets.push(`price_per_ml = $${i++}`); vals.push(MRP_PER_ML);
      sets.push(`gst_rate = $${i++}`);     vals.push(GST_RATE);
      sets.push(`total_before_gst = $${i++}`); vals.push(total_before_gst);
      sets.push(`gst_amount = $${i++}`);       vals.push(gst_amount);
      sets.push(`total_with_gst = $${i++}`);   vals.push(total_with_gst);
    }
    sets.push(`updated_at = NOW()`);

    const sql = `UPDATE invoices SET ${sets.join(", ")} WHERE id=$${i} RETURNING *`;
    vals.push(req.params.id);

    const r = await pool.query(sql, vals);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });

    await audit({
      req, actor: me, action: "invoice_update", entity_type: "invoice", entity_id: req.params.id,
      details: { changed_fields: Object.keys(b) }
    });

    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ---------- invoices: export CSV ----------
app.get("/api/invoices/export", async (req, res) => {
  const me = whoami(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });

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

    await audit({
      req, actor: me, action: "export_csv", entity_type: "invoice_export", entity_id: null,
      details: { count: rows.length }
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=invoices_export.csv");
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ---------- DISPUTE / EVIDENCE (Phase 2.1 groundwork) ----------

// Admin: create ticket for an invoice
app.post("/api/tickets", async (req, res) => {
  const me = whoami(req);
  if (!me || (me.role !== "admin" && me.role !== "super_admin"))
    return res.status(401).json({ error: "unauthorized" });

  try {
    const { invoice_id, reason } = req.body || {};
    if (!invoice_id || !reason) return res.status(400).json({ error: "missing_fields" });

    const r = await pool.query(
      `INSERT INTO dispute_tickets (invoice_id, reason, status, created_by, created_role)
       VALUES ($1,$2,'open',$3,$4) RETURNING id`,
      [invoice_id, reason, me.id, me.role]
    );

    await audit({
      req, actor: me, action: "ticket_create", entity_type: "ticket", entity_id: r.rows[0].id,
      details: { invoice_id, reason }
    });

    res.status(201).json({ id: r.rows[0].id, status: "open" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Super Admin: approve ticket
app.post("/api/tickets/:id/approve", async (req, res) => {
  const me = whoami(req);
  if (!me || me.role !== "super_admin")
    return res.status(401).json({ error: "unauthorized" });

  try {
    const r = await pool.query(
      `UPDATE dispute_tickets
       SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
       WHERE id=$2 RETURNING *`,
      [me.id, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });

    await audit({
      req, actor: me, action: "ticket_approve", entity_type: "ticket", entity_id: req.params.id,
      details: {}
    });

    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Evidence pack (stub): Admin after approval, SA anytime
app.get("/api/tickets/:id/evidence", async (req, res) => {
  const me = whoami(req);
  if (!me || (me.role !== "admin" && me.role !== "super_admin"))
    return res.status(401).json({ error: "unauthorized" });

  try {
    const t = await pool.query(`SELECT * FROM dispute_tickets WHERE id=$1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ error: "not_found" });

    if (me.role === "admin" && t.rows[0].status !== "approved") {
      return res.status(403).json({ error: "not_approved" });
    }

    const invId = t.rows[0].invoice_id;
    const inv = await pool.query(`SELECT * FROM invoices WHERE id=$1`, [invId]);
    if (!inv.rows.length) return res.status(404).json({ error: "invoice_not_found" });

    // Phase 2.1: return real ZIP; for now we return JSON stub (so feature is gated but usable for tests)
    await audit({
      req, actor: me, action: "evidence_fetch", entity_type: "ticket", entity_id: req.params.id,
      details: { invoice_id: invId }
    });

    return res.json({
      ticket: t.rows[0],
      invoice_snapshot: inv.rows[0],
      note: "Evidence ZIP generation will be enabled in Phase 2.1"
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Super Admin: direct evidence by invoice (no ticket) – stub
app.get("/api/invoices/:id/evidence", async (req, res) => {
  const me = whoami(req);
  if (!me || me.role !== "super_admin")
    return res.status(401).json({ error: "unauthorized" });

  try {
    const inv = await pool.query(`SELECT * FROM invoices WHERE id=$1`, [req.params.id]);
    if (!inv.rows.length) return res.status(404).json({ error: "invoice_not_found" });

    await audit({
      req, actor: me, action: "evidence_fetch_direct", entity_type: "invoice", entity_id: req.params.id,
      details: {}
    });

    return res.json({
      invoice_snapshot: inv.rows[0],
      note: "Direct evidence ZIP generation will be enabled in Phase 2.1"
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// ---------- start ----------
app.listen(PORT, async () => {
  await ensureTables();
  console.log(`API listening on ${PORT}`);
});
