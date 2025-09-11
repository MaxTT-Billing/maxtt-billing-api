// routes/system.js
const { Pool } = require("pg");
const { runSelfTest } = require("../src/selftest");

module.exports = (app) => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  app.get("/__db/installations-selftest", async (req, res) => {
    try {
      const report = await runSelfTest(pool);
      res.status(200).json({ ok: true, report });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message || err) });
    }
  });
};
