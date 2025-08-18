// server.js (ESM, regex-free, with diagnostics + create-view) — maxtt-billing-api

import express from 'express'
import cors from 'cors'
import pkg from 'pg'
const { Pool } = pkg

const app = express()
app.use(cors())
app.use(express.json())

// --- DB connection (Render → Environment → DATABASE_URL must be set) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// ---------- Simple test routes ----------
app.get('/', (_req, res) => res.send('MaxTT API is running'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// ---------- Diagnostics ----------
app.get('/api/diag/db', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW() AS now')
    res.json({ ok: true, db_time: r.rows[0].now })
  } catch (err) {
    res.status(500).json({ ok: false, where: 'db_connect', message: err?.message || String(err) })
  }
})

app.get('/api/diag/view', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT to_regclass('public.v_invoice_export') AS v`)
    const exists = r.rows[0]?.v
    if (!exists) return res.json({ ok: false, where: 'view_check', reason: 'view_missing' })
    res.json({ ok: true, view: String(exists) })
  } catch (err) {
    res.status(500).json({ ok: false, where: 'view_check', message: err?.message || String(err) })
  }
})

// tells
