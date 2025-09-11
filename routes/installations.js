// routes/installations.js — production with ADMIN_KEY auth + simple rate limiting

import pkg from "pg";
import {
  detectInventoryMapping,
  getInventoryRowForUpdate,
  deductStockAndReturn,
} from "../src/inventory.js";

const { Pool } = pkg;
const MIN_STOCK_L = 20.0;

export default function installationsRouter(app) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // ---- ADMIN KEY auth (set ADMIN_KEY in env) ----
  const ADMIN_KEY = process.env.ADMIN_KEY;
  function requireAdmin(req, res, next) {
    if (!ADMIN_KEY) return next(); // allow in dev if not set
    const key = req.get("X-ADMIN-KEY");
    if (key && key === ADMIN_KEY) return next();
    return res.status(401).json({ ok: false, code: "unauthorized" });
  }

  // ---- Simple rate limiting (per X-ADMIN-KEY or IP) ----
  // Defaults: 30 requests / 60s per key (or per IP if no key).
  const RL_WINDOW_MS = Number(process.env.RL_WINDOW_MS || 60_000);
  const RL_MAX = Number(process.env.RL_MAX || 30);
  const buckets = new Map(); // id -> { count, resetAt }

  function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.get("X-ADMIN-KEY") || req.ip || "anon";
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + RL_WINDOW_MS };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > RL_MAX) {
      const retry = Math.max(0, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({ ok: false, code: "rate_limited", retry_after_s: retry });
    }
    next();
  }

  // ---------------------------
  // POST /installations/start
  // ---------------------------
  app.post("/installations/start", requireAdmin, rateLimit, async (req, res) => {
    const { franchisee_id } = req.body || {};
    if (!franchisee_id) {
      return res.status(400).json({ ok: false, code: "missing_franchisee_id" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const mapping = await detectInventoryMapping(client);
      if (!mapping) {
        await client.query("ROLLBACK");
        return res.status(500).json({ ok: false, code: "inventory_mapping_not_found" });
      }

      const inv = await getInventoryRowForUpdate(client, mapping, franchisee_id);
      if (!inv) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, code: "inventory_row_not_found", franchisee_id });
      }

      const available = parseFloat(inv.available_litres);
      if (!Number.isFinite(available)) {
        await client.query("ROLLBACK");
        return res.status(500).json({ ok: false, code: "invalid_inventory_value", details: inv });
      }

      if (available < MIN_STOCK_L) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          code: "stock_below_threshold",
          threshold_litres: MIN_STOCK_L,
          available_litres: available,
        });
      }

      const ins = await client.query(
        `INSERT INTO installations
           (franchisee_id, stock_check_litres_snapshot, allowed_to_proceed, status)
         VALUES ($1, $2, TRUE, 'started')
         RETURNING id, franchisee_id, stock_check_litres_snapshot, allowed_to_proceed, status, created_at`,
        [franchisee_id, available]
      );

      await client.query("COMMIT");
      const row = ins.rows[0];
      return res.status(201).json({
        ok: true,
        installation_id: row.id,
        snapshot_litres: row.stock_check_litres_snapshot,
        checked_at: row.created_at,
        threshold_litres: MIN_STOCK_L,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      return res.status(500).json({ ok: false, code: "start_failed", message: e.message });
    } finally {
      client.release();
    }
  });

  // ------------------------------
  // POST /installations/complete
  // ------------------------------
  app.post("/installations/complete", requireAdmin, rateLimit, async (req, res) => {
    const { installation_id, used_litres } = req.body || {};
    const used = parseFloat(used_litres);
    if (!installation_id || !Number.isFinite(used) || used <= 0) {
      return res.status(400).json({ ok: false, code: "invalid_input" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const q = await client.query(
        `SELECT id, franchisee_id, allowed_to_proceed, status
           FROM installations
          WHERE id=$1
          FOR UPDATE`,
        [installation_id]
      );
      if (q.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, code: "installation_not_found" });
      }
      const inst = q.rows[0];

      if (inst.status !== "started") {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, code: "already_finalized", status: inst.status });
      }
      if (!inst.allowed_to_proceed) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, code: "not_allowed_to_proceed" });
      }

      const mapping = await detectInventoryMapping(client);
      if (!mapping) {
        await client.query("ROLLBACK");
        return res.status(500).json({ ok: false, code: "inventory_mapping_not_found" });
      }

      const deduct = await deductStockAndReturn(
        client,
        mapping,
        inst.franchisee_id,
        used
      );
      if (!deduct || deduct.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, code: "insufficient_stock_for_deduction" });
      }
      const newAvail = parseFloat(deduct.rows[0].available_litres);

      const upd = await client.query(
        `UPDATE installations
            SET status='completed', used_litres=$2, completed_at=NOW()
          WHERE id=$1
      RETURNING id, status, used_litres, completed_at, updated_at`,
        [installation_id, used]
      );

      await client.query("COMMIT");
      return res.status(200).json({
        ok: true,
        installation: upd.rows[0],
        available_litres_after: newAvail,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      return res.status(500).json({ ok: false, code: "complete_failed", message: e.message });
    } finally {
      client.release();
    }
  });

  // ----------------------------
  // POST /installations/cancel
  // ----------------------------
  app.post("/installations/cancel", requireAdmin, rateLimit, async (req, res) => {
    const { installation_id } = req.body || {};
    if (!installation_id) {
      return res.status(400).json({ ok: false, code: "invalid_input" });
    }

    try {
      const r = await pool.query(
        `UPDATE installations
            SET status='cancelled'
          WHERE id=$1 AND status='started'
      RETURNING id, status, updated_at`,
        [installation_id]
      );
      if (r.rowCount === 0) {
        return res.status(409).json({ ok: false, code: "not_started_or_missing" });
      }
      return res.status(200).json({ ok: true, installation: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ ok: false, code: "cancel_failed", message: e.message });
    }
  });
}
