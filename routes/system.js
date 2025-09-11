// routes/system.js  (ESM)
// NOTE: must export a *default* function

import pkg from "pg";
import { runSelfTest } from "../src/selftest.js";

const { Pool } = pkg;

export default function systemRouter(app) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  app.get("/__db/installations-selftest", async (req, res) => {
    try {
      const report = await runSelfTest(pool);
      res.status(200).json({ ok: true, report });
    } catch (err) {
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });
}
