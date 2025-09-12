// routes/installations.js — token-protected installs (Strict Actuals, ESM-safe)

import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---- Token verify (same scheme as server.js, ESM) ----
const AUTH_SECRET = process.env.AUTH_SECRET || '';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function verifyToken(token) {
  try {
    const [v, p64, sig] = String(token || '').split('.');
    if (v !== 'v1' || !p64 || !sig) return null;
    const expected = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(`${v}.${p64}`).digest());
    if (sig !== expected) return null;

    const json = Buffer.from(p64.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');
    const obj = JSON.parse(json);
    if (!obj?.sub || !obj?.exp) return null;
    if (Math.floor(Date.now()/1000) > Number(obj.exp)) return null;
    return { franchisee_id: String(obj.sub) };
  } catch { return null; }
}
function requireFranchisee(req, res, next) {
  if (!AUTH_SECRET) return res.status(500).json({ ok: false, code: 'auth_secret_not_set' });
  const auth = req.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const alt = req.get('X-FRANCHISEE-TOKEN') || '';
  const parsed = verifyToken(bearer || alt);
  if (!parsed) return res.status(401).json({ ok: false, code: 'unauthorized' });
  req.franchisee_id = parsed.franchisee_id;
  next();
}

// ---- Inventory config ----
const INV_TABLE = process.env.INVENTORY_TABLE || 'inventory';
const INV_FR_COL = process.env.INVENTORY_FRANCHISEE_COL || 'franchisee_id';
const INV_STOCK_COL = process.env.INVENTORY_STOCK_COL || 'available_litres';
const STOCK_THRESHOLD_LITRES = Number(process.env.STOCK_THRESHOLD_LITRES || 20);

const qid = n => `"${n}"`;

export default function installationsRouter(app) {
  // Start installation
  app.post('/installations/start', requireFranchisee, async (req, res) => {
    const client = await pool.connect();
    try {
      const frid = req.franchisee_id;
      const r = await client.query(
        `SELECT ${qid(INV_STOCK_COL)} AS stock
           FROM public.${qid(INV_TABLE)}
          WHERE ${qid(INV_FR_COL)}=$1
          LIMIT 1`,
        [frid]
      );
      const snap = r.rowCount ? Number(r.rows[0].stock) : 0;
      const allowed = snap >= STOCK_THRESHOLD_LITRES;
      const now = new Date().toISOString();

      const ins = await client.query(
        `INSERT INTO public.installations
           (franchisee_id, stock_check_litres_snapshot, stock_check_time, allowed_to_proceed, status, created_at)
         VALUES ($1,$2,$3,$4,'started',$5)
         RETURNING id`,
        [frid, snap, now, allowed, now]
      );

      res.status(200).json({
        ok: true,
        installation_id: String(ins.rows[0].id),
        snapshot_litres: snap,
        checked_at: now,
        threshold_litres: STOCK_THRESHOLD_LITRES,
        allowed_to_proceed: allowed,
      });
    } catch (e) {
      res.status(500).json({ ok: false, code: 'start_failed', message: e?.message || String(e) });
    } finally {
      client.release();
    }
  });

  // Complete installation
  app.post('/installations/complete', requireFranchisee, async (req, res) => {
    const { id, used_litres } = req.body || {};
    const iid = Number(id);
    const used = Number(used_litres);
    if (!Number.isFinite(iid) || iid <= 0) return res.status(400).json({ ok: false, code: 'bad_id' });
    if (!Number.isFinite(used) || used <= 0) return res.status(400).json({ ok: false, code: 'bad_used_litres' });

    const frid = req.franchisee_id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const r = await client.query(`SELECT * FROM public.installations WHERE id=$1 FOR UPDATE`, [iid]);
      if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, code: 'not_found' }); }
      const row = r.rows[0];
      if (row.franchisee_id !== frid) { await client.query('ROLLBACK'); return res.status(403).json({ ok: false, code: 'wrong_owner' }); }
      if (row.status === 'completed') { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, code: 'already_completed' }); }

      const sel = await client.query(
        `SELECT ${qid(INV_STOCK_COL)} AS stock
           FROM public.${qid(INV_TABLE)}
          WHERE ${qid(INV_FR_COL)}=$1
          FOR UPDATE`,
        [frid]
      );
      if (!sel.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, code: 'inventory_row_missing' }); }

      const current = Number(sel.rows[0].stock || 0);
      const after = current - used;
      if (after < 0) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, code: 'insufficient_stock', available_litres: current }); }

      await client.query(
        `UPDATE public.${qid(INV_TABLE)} SET ${qid(INV_STOCK_COL)}=$2 WHERE ${qid(INV_FR_COL)}=$1`,
        [frid, after]
      );
      const now = new Date().toISOString();
      await client.query(
        `UPDATE public.installations
            SET status='completed', used_litres=$2, completed_at=$3, updated_at=$3
          WHERE id=$1`,
        [iid, used, now]
      );

      await client.query('COMMIT');
      res.status(200).json({
        ok: true,
        installation: { id: String(iid), status: 'completed', used_litres: used, completed_at: now, updated_at: now },
        available_litres_after: after
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(500).json({ ok: false, code: 'complete_failed', message: e?.message || String(e) });
    } finally {
      client.release();
    }
  });
}
