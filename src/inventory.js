// src/inventory.js  (ESM)
const STOCK_COL_CANDIDATES = [
  "available_litres", "available_ltrs", "stock_litres", "stock_ltrs",
  "balance_litres", "balance_ltrs", "stock"
];
const FRANCHISEE_COL_CANDIDATES = ["franchisee_id", "fr_code", "franchise_code", "kiosk_id"];

let cached = null;

function isSafeIdentifier(s) {
  return typeof s === "string" && /^[a-zA-Z0-9_]+$/.test(s);
}

export async function detectInventoryMapping(client) {
  if (cached) return cached;

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

    // prefer tables named like inventory/stock
    const score =
      (table.includes("inventory") ? 2 : 0) +
      (table.includes("stock") ? 1 : 0) + 1;

    if (!best || score > best.score) {
      best = { table, franchiseeCol: hasFr, stockCol: hasStock, score };
    }
  }

  if (!best) return null;
  if (![best.table, best.franchiseeCol, best.stockCol].every(isSafeIdentifier)) return null;

  cached = { table: best.table, franchiseeCol: best.franchiseeCol, stockCol: best.stockCol };
  return cached;
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

export async function deductStockAndReturn(client, mapping, franchiseeId, usedLitres) {
  // prevent negative stock in one statement
  const sql = `
    UPDATE "${mapping.table}"
       SET "${mapping.stockCol}" = "${mapping.stockCol}" - $2
     WHERE "${mapping.franchiseeCol}" = $1
       AND "${mapping.stockCol}"::numeric >= $2
     RETURNING "${mapping.stockCol}"::numeric AS available_litres
  `;
  return client.query(sql, [franchiseeId, usedLitres]);
}
