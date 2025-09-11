// src/selftest.js  (ESM)
// NOTE: must export a *named* function: runSelfTest

export async function runSelfTest(pool) {
  const report = {
    steps: [],
    notes: "Verifies 'installations' table + status constraint + basic write path",
  };
  const push = (name, ok, details = null) => report.steps.push({ name, ok, details });

  const client = await pool.connect();
  let insertedId = null;

  try {
    // STEP A: table existence
    const a = await client.query("SELECT to_regclass('public.installations') AS exists_check;");
    const exists = a.rows[0] && a.rows[0].exists_check !== null;
    push("A_table_exists", exists, { exists_check: a.rows[0] && a.rows[0].exists_check });
    if (!exists) return report;

    // STEP B: schema columns
    const b = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='installations'
      ORDER BY ordinal_position;
    `);
    push("B_schema_columns", true, { columns: b.rows });

    // STEP C: insert dummy row
    const c = await client.query(
      `INSERT INTO installations
         (franchisee_id, stock_check_litres_snapshot, allowed_to_proceed, status)
       VALUES ($1, $2, $3, 'started')
       RETURNING id, franchisee_id, stock_check_litres_snapshot, allowed_to_proceed, status, created_at;`,
      ["MAXTT-DEMO-001", 25.0, true]
    );
    insertedId = c.rows[0].id;
    push("C_insert_started", true, c.rows[0]);

    // STEP D: update to completed
    const d = await client.query(
      `UPDATE installations
         SET status='completed', used_litres=$2, completed_at=NOW()
       WHERE id=$1
       RETURNING id, status, used_litres, completed_at, updated_at;`,
      [insertedId, 1.25]
    );
    push("D_update_completed", true, d.rows[0]);

    // STEP E: invalid status (expect constraint error)
    try {
      await client.query(`UPDATE installations SET status='foo' WHERE id=$1;`, [insertedId]);
      push("E_invalid_status_constraint", false, "Unexpectedly succeeded");
    } catch (e) {
      push("E_invalid_status_constraint", true, { message: e.message });
    }

    // STEP F: cleanup
    const f = await client.query(`DELETE FROM installations WHERE id=$1 RETURNING id;`, [insertedId]);
    push("F_cleanup_delete", f.rowCount === 1, { deleted_id: f.rows[0]?.id || null });

    return report;
  } finally {
    client.release();
  }
}
