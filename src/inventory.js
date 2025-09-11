// src/inventory.js  (ESM) — Expanded detector + schema helpers

// Broadened synonym sets (UK/US spellings + common variants)
const STOCK_COL_CANDIDATES = [
  "available_litres","available_ltrs","available_liters","available_ltr","available",
  "available_stock","available_qty","qty_litres","qty_liters","quantity_litres","quantity_liters",
  "stock_litres","stock_liters","stock","stock_qty","stock_quantity",
  "balance_litres","balance_ltrs","balance_liters","balance","current_stock","current_qty"
];

const FRANCHISEE_COL_CANDIDATES = [
  "franchisee_id","franchisee","franchisee_code","franchise_code","fr_code","frcode",
  "kiosk_id","kiosk_code","kiosk","outlet_id","outlet_code",
  "partner_id","partner_code","dealer_id","dealer_code"
];

let cached = null;

function isSafeIdentifier(s) {
  return typeof s === "string" && /^[a-zA-Z0-9_]+$/.test(s);
}

// ENV override support: set INVENTORY_TABLE, INVENTORY_FRANCHISEE_COL, INVENTORY_STOCK_COL
function envMapping() {
  const table = process.env.INVENTORY_TABLE;
  const franchiseeCol = process.env.INVENTORY_FRANCHISEE_COL;
  const stockCol = process.env.INVENTORY_STOCK_COL;
  if (table && franchiseeCol && stockCol && [table, franchiseeCol, stockCol].every(isSafeIdentifier)) {
    return { table, franchiseeCol, stockCol, source: "env" };
  }
  return null;
}

export async function detectInventoryMapping(client) {
  if (cached) return cached;

  // 1) ENV overrides win
  const env = envMapping();
  if (env) { cached = env; return cached; }

  // 2) Auto-scan information_schema
  const q = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public'
  `);

  // Group by table
  const byTable = new Map();
  for (const r of q.rows) {
    const t = r.table_name;
    if (!byTable.has(t)) byTable.set(t, new Set());
    byTable.get(t).add(r.column_name);
  }

  // Score candidates: prefer tables named like inventory/stock/franchisee/kiosk
  let best = null;
  for (const [table, colsSet] of byTable.entries()) {
    const cols = Array.from(colsSet);
    const hasFr = FRANCHISEE_COL_CANDIDATES.find(c => cols.includes(c));
    const hasStock = STOCK_COL_CANDIDATES.find(c => cols.includes(c));
    if (!hasFr || !hasStock) continue;

    const t = table.toLowerCase();
    const score =
      (t.includes("inventory") ? 4 : 0) +
      (t.includes("stock") ? 3 : 0) +
      (t.includes("franchisee") ? 2 : 0) +
      (t.includes("kiosk") ? 1 : 0) + 1;

    if (!best || score > best.score) {
      best = { table, franchiseeCol: hasFr, stockCol: hasStock, score };
    }
  }

  if (!best) return null;
  if (![best.table, best.franchiseeCol, best.stockCol].every(isSafeIdentifier)) return null;

  cached = { table: best.table, franchiseeCol: best.franchiseeCol, stockCol: best.stockCol, source: "auto" };
  return cached;
}

export function setManualMappingForSession(table, franchiseeCol, stockCol) {
  if ([table, franchiseeCol, stockCol].every(isSafeIdentifier)) {
    cached = { table, franchiseeCol, stockCol, source: "manual" };
    return cached;
  }
  return null;
}

// ---- Inventory row helpers
export async function getInventoryRowForUpdate(client, mapping, franchiseeId) {
  const sql = `
    SELECT "${mapping.stockCol}"::numeric AS available_litres
    FROM "${mapping.table}"
    WHERE "${mapping.franchiseeCol}" = $1
    FOR UPDATE
  `;
  const r = await client.query(sql, [franchiseeId]);
  return r.rowCount ? r.rows[0] : null;
}

export async function listInventoryRows(client, mapping, limit = 10) {
  const sql = `
    SELECT "${mapping.franchiseeCol}" AS franchisee_id, "${mapping.stockCol}"::numeric AS available_litres
    FROM "${mapping.table}"
    ORDER BY 1
    LIMIT $1
  `;
  return client.query(sql, [limit]);
}

export async function insertOrUpdateInventoryRow(client, mapping, franchiseeId, litres) {
  // Try update then insert (works without unique constraint too, but may duplicate if not careful)
  const upd = await client.query(
    `UPDATE "${mapping.table}"
        SET "${mapping.stockCol}" = $2
      WHERE "${mapping.franchiseeCol}" = $1
      RETURNING "${mapping.franchiseeCol}"`,
    [franchiseeId, litres]
  );
  if (upd.rowCount) return { action: "updated" };

  await client.query(
    `INSERT INTO "${mapping.table}" ("${mapping.franchiseeCol}", "${mapping.stockCol}")
     VALUES ($1, $2)`,
    [franchiseeId, litres]
  );
  return { action: "inserted" };
}

export async function deductStockAndReturn(client, mapping, franchiseeId, usedLitres) {
  const sql = `
    UPDATE "${mapping.table}"
       SET "${mapping.stockCol}" = "${mapping.stockCol}" - $2
     WHERE "${mapping.franchiseeCol}" = $1
       AND "${mapping.stockCol}"::numeric >= $2
     RETURNING "${mapping.stockCol}"::numeric AS available_litres
  `;
  return client.query(sql, [franchiseeId, usedLitres]);
}

// ---- Schema helpers for debugging/selection
export async function listAllTables(client, like = null) {
  if (like) {
    return client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema='public' AND table_name ILIKE $1
        ORDER BY table_name`,
      [`%${like}%`]
    );
  }
  return client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema='public'
      ORDER BY table_name`
  );
}

export async function listColumnsForTable(client, table) {
  if (!isSafeIdentifier(table)) return { rows: [] };
  return client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [table]
  );
}
