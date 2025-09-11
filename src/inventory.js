// src/inventory.js  (ESM)
// Supports ENV overrides and scanning to find inventory table/columns.

const STOCK_COL_CANDIDATES = [
  "available_litres", "available_ltrs", "stock_litres", "stock_ltrs",
  "balance_litres", "balance_ltrs", "stock"
];
const FRANCHISEE_COL_CANDIDATES = ["franchisee_id", "fr_code", "franchise_code", "kiosk_id"];

let cached = null;

function isSafeIdentifier(s) {
  return typeof s === "string" && /^[a-zA-Z0-9_]+$/.test(s);
}

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
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public'
  `);
  const byTable = new Map();
  for (const row of q.rows) {
    const t = row.table_name;
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push(row);
  }

  let best = null;
  for (const [table, cols] of byTable.entries()) {
    const names = cols.map(c => c.column_name);
    const hasFr = FRANCHISEE_COL_CANDIDATES.find(c => names.includes(c));
    const hasStock = STOCK_COL_CANDIDATES.find(c => names.includes(c));
    if (!hasFr || !hasStock) continue;

    // Prefer tables named like inventory/stock
    const score =
      (table.includes("inventory") ? 2 : 0) +
      (table.includes("stock") ? 1 : 0) + 1;

    if (!best || score > best.score) {
      best = { table, franchiseeCol: hasFr, stockCol: hasStock, score };
    }
  }

  if (!best) return null;
  if (![best.table, best.franchiseeCol, best.stockCol].every(isSafeIdentifier)) return null;

  cached = { table: best.table, franchiseeCol: best.franchiseeCol, stockCol: best.stockCol, source: "auto" };
  return cached;
}

export async function scanInventoryCandidates(client) {
  const q = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public'
  `);
  const m = new Map();
  for (const r of q.rows) {
    if (!m.has(r.table_name)) m.set(r.table_name, { table: r.table_name, cols: [] });
    m.get(r.table_name).cols.push(r.column_name);
  }
  const picks = [];
  for (const { table, cols } of m.values()) {
    const fr = FRANCHISEE_COL_CANDIDATES.filter(c => cols.includes(c));
    const st = STOCK_COL_CANDIDATES.filter(c => cols.includes(c));
    if (fr.length && st.length) {
      picks.push({ table, franchiseeCols: fr, stockCols: st });
    }
  }
  return picks;
}

export function setManualMappingForSession(table, franchiseeCol, stockCol) {
  if ([table, franchiseeCol, stockCol].every(isSafeIdentifier)) {
    cached = { table, franchiseeCol, stockCol, source: "manual" };
    return cached;
  }
  return null;
}

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
  // Upsert-ish (works if there's unique constraint; if not, try update then insert)
  // First attempt update
  const upd = await client.query(
    `UPDATE "${mapping.table}"
        SET "${mapping.stockCol}" = $2
      WHERE "${mapping.franchiseeCol}" = $1
      RETURNING "${mapping.franchiseeCol}"`,
    [franchiseeId, litres]
  );
  if (upd.rowCount) return { action: "updated" };

  // Fallback insert
  const sql = `
    INSERT INTO "${mapping.table}" ("${mapping.franchiseeCol}", "${mapping.stockCol}")
    VALUES ($1, $2)
  `;
  await client.query(sql, [franchiseeId, litres]);
  return { action: "inserted" };
}

export async function deductStockAndReturn(client, mapping, franchiseeId, usedLitres) {
  // Prevent negative stock atomically
  const sql = `
    UPDATE "${mapping.table}"
       SET "${mapping.stockCol}" = "${mapping.stockCol}" - $2
     WHERE "${mapping.franchiseeCol}" = $1
       AND "${mapping.stockCol}"::numeric >= $2
     RETURNING "${mapping.stockCol}"::numeric AS available_litres
  `;
  return client.query(sql, [franchiseeId, usedLitres]);
}
