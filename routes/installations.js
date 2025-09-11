// routes/installations.js  (ESM)

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

  // ---------------------------
  // POST /installations/start
  // body: { franchisee_id: "MAXTT-..." }
  // ---------------------------
  app.post("/installations/start", async (req, res) => {
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
        return res
          .status(500)
          .json({ ok: false, code: "inventory_mapping_not_found" });
      }

      const inv = await getInventoryRowForUpdate(client, mapping, franchisee_id);
      if (!inv) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ ok: false, code: "inventory_row_not_found", franchisee_id });
      }

      const available = parseFloat(inv.available_litres);
      if (!Number.isFinite(available)) {
        await client.query("ROLLBACK");
        return res
          .status(500)
          .json({ ok: false, code: "invalid_inventory_value", details: inv });
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
      return res
        .status(500)
        .json({ ok: false, code: "start_failed", message: e.message });
    } finally {
      client.release();
    }
  });

  // ------------------------------
  // POST /installations/complete
  // body: { installation_id: 123, used_litres: 1.25 }
  // ------------------------------
  app.post("/installations/complete", async (req, res) => {
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
        return res
          .status(404)
          .json({ ok: false, code: "installation_not_found" });
      }
      const inst = q.rows[0];

      if (inst.status !== "started") {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ ok: false, code: "already_finalized", status: inst.status });
      }
      if (!inst.allowed_to_proceed) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ ok: false, code: "not_allowed_to_proceed" });
      }

      const mapping = await detectInventoryMapping(client);
      if (!mapping) {
        await client.query("ROLLBACK");
        return res
          .status(500)
          .json({ ok: false, code: "inventory_mapping_not_found" });
      }

      const deduct = await deductStockAndReturn(
        client,
        mapping,
        inst.franchisee_id,
        used
      );
      if (!deduct || deduct.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          code: "insufficient_stock_for_deduction",
        });
      }
      const newAvail = parseFloat(deduct.rows[0].available_litres);

      const upd = await client.query(
        `UPDATE installations
            SET status='completed',
                used_litres=$2,
                completed_at=NOW()
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
      return res
        .status(500)
        .json({ ok: false, code: "complete_failed", message: e.message });
    } finally {
      client.release();
    }
  });

  // ----------------------------
  // POST /installations/cancel
  // body: { installation_id }
  // ----------------------------
  app.post("/installations/cancel", async (req, res) => {
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
        return res
          .status(409)
          .json({ ok: false, code: "not_started_or_missing" });
      }
      return res.status(200).json({ ok: true, installation: r.rows[0] });
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, code: "cancel_failed", message: e.message });
    }
  });

  // ---------------------------------------------------------
  // TEMP: GET debug aliases for browser testing (to remove)
  // ---------------------------------------------------------

  // GET /__dbg/installations/start?franchisee_id=MAXTT-DEMO-001
  app.get("/__dbg/installations/start", async (req, res) => {
    const franchisee_id = req.query.franchisee_id;
    if (!franchisee_id) {
      return res.status(400).json({ ok: false, code: "missing_franchisee_id" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const mapping = await detectInventoryMapping(client);
      if (!mapping) {
        await client.query("ROLLBACK");
        return res
          .status(500)
          .json({ ok: false, code: "inventory_mapping_not_found" });
      }

      const inv = await getInventoryRowForUpdate(client, mapping, franchisee_id);
      if (!inv) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ ok: false, code: "inventory_row_not_found", franchisee_id });
      }

      const available = parseFloat(inv.available_litres);
      if (!Number.isFinite(available)) {
        await client.query("ROLLBACK");
        return res
          .status(500)
          .json({ ok: false, code: "invalid_inventory_value", details: inv });
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
      res.status(201).json({
        ok: true,
        installation_id: row.id,
        snapshot_litres: row.stock_check_litres_snapshot,
        checked_at: row.created_at,
        threshold_litres: MIN_STOCK_L,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      res
        .status(500)
        .json({ ok: false, code: "start_failed", message: e.message });
    } finally {
      client.release();
    }
  });

  // GET /__dbg/installations/complete?installation_id=<ID>&used_litres=1.25
  app.get("/__dbg/installations/complete", async (req, res) => {
    const installation_id =
      req.query.installation_id && Number(req.query.installation_id);
    const used = req.query.used_litres && Number(req.query.used_litres);
    if (!installation_id || !used || used <= 0) {
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
        return res
          .status(404)
          .json({ ok: false, code: "installation_not_found" });
      }
      const inst = q.rows[0];

      if (inst.status !== "started") {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ ok: false, code: "already_finalized", status: inst.status });
      }
      if (!inst.allowed_to_proceed) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ ok: false, code: "not_allowed_to_proceed" });
      }

      const mapping = await detectInventoryMapping(client);
      if (!mapping) {
        await client.query("ROLLBACK");
        return res
          .status(500)
          .json({ ok: false, code: "inventory_mapping_not_found" });
      }

      const deduct = await deductStockAndReturn(
        client,
        mapping,
        inst.franchisee_id,
        used
      );
      if (!deduct || deduct.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          code: "insufficient_stock_for_deduction",
        });
      }
      const newAvail = parseFloat(deduct.rows[0].available_litres);

      const upd = await client.query(
        `UPDATE installations
            SET status='completed',
                used_litres=$2,
                completed_at=NOW()
          WHERE id=$1
      RETURNING id, status, used_litres, completed_at, updated_at`,
        [installation_id, used]
      );

      await client.query("COMMIT");
      res.status(200).json({
        ok: true,
        installation: upd.rows[0],
        available_litres_after: newAvail,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      res
        .status(500)
        .json({ ok: false, code: "complete_failed", message: e.message });
    } finally {
      client.release();
    }
  });
}
