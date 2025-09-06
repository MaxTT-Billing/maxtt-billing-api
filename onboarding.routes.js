// onboarding.routes.js
import express from 'express';
import bcrypt from 'bcryptjs';
import { q } from './db.js';
import { requireRole } from './authz.js';
import { applicationSchema } from './onboarding.validation.js';

const router = express.Router();
const PREFIX = process.env.FRANCHISEE_PREFIX || 'MAXTT';
const PEPPER = process.env.PASSWORD_PEPPER || '';

/** Helpers */
const toApp = r => ({
  id: r.id, status: r.status, legal_name: r.legal_name, trade_name: r.trade_name,
  contact_person: r.contact_person, email: r.email, phone: r.phone,
  gstin: r.gstin, pan: r.pan, address_line1: r.address_line1, address_line2: r.address_line2,
  city: r.city, state: r.state, pincode: r.pincode, is_locked: r.is_locked,
  created_at: r.created_at, updated_at: r.updated_at, created_by: r.created_by
});

const pad3 = n => String(n).padStart(3, '0');

async function generateFranchiseeCode() {
  const { rows } = await q('SELECT nextval(\'franchisee_code_seq\') AS seq');
  return `${PREFIX}-${pad3(rows[0].seq)}`;
}

async function logAction(application_id, actor_user_id, action, notes=null) {
  await q(
    `INSERT INTO application_approvals(application_id, actor_user_id, action, notes)
     VALUES ($1,$2,$3,$4)`,
    [application_id, actor_user_id, action, notes]
  );
}

/** List applications (Admin/SA) */
router.get('/applications', requireRole('ADMIN','SA'), async (req, res) => {
  const { status } = req.query;
  const params = [];
  let sql = `SELECT * FROM franchisee_applications`;
  if (status) { sql += ` WHERE status=$1`; params.push(status); }
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  const { rows } = await q(sql, params);
  res.json(rows.map(toApp));
});

/** Create or update DRAFT (Admin) */
router.post('/applications', requireRole('ADMIN','SA'), async (req, res) => {
  const val = applicationSchema.safeParse(req.body);
  if (!val.success) return res.status(400).json({ error: val.error.flatten() });

  const u = req.user;
  const r = val.data;

  const { rows } = await q(
    `INSERT INTO franchisee_applications
     (status, created_by, legal_name, trade_name, contact_person, email, phone,
      gstin, pan, address_line1, address_line2, city, state, pincode)
     VALUES ('DRAFT',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [u.id, r.legal_name, r.trade_name || null, r.contact_person, r.email, r.phone, r.gstin, r.pan,
     r.address_line1, r.address_line2 || null, r.city, r.state, r.pincode]
  );
  await logAction(rows[0].id, u.id, 'CREATE');
  res.status(201).json(toApp(rows[0]));
});

/** Submit application (Admin) */
router.post('/applications/:id/submit', requireRole('ADMIN','SA'), async (req, res) => {
  const u = req.user;
  const { id } = req.params;
  const { rows } = await q(
    `UPDATE franchisee_applications SET status='SUBMITTED'
     WHERE id=$1 AND status IN ('DRAFT','REQUESTED_CHANGES')
     RETURNING *`, [id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid state transition' });
  await logAction(id, u.id, 'SUBMIT');
  res.json(toApp(rows[0]));
});

/** Request changes (Admin) */
router.post('/applications/:id/request-changes', requireRole('ADMIN','SA'), async (req, res) => {
  const u = req.user; const { id } = req.params; const { notes } = req.body || {};
  const { rows } = await q(
    `UPDATE franchisee_applications SET status='REQUESTED_CHANGES'
     WHERE id=$1 AND status IN ('SUBMITTED','DOCS_VERIFIED')
     RETURNING *`, [id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid state transition' });
  await logAction(id, u.id, 'REQUEST_CHANGES', notes||null);
  res.json(toApp(rows[0]));
});

/** Mark docs verified (Admin) */
router.post('/applications/:id/verify-docs', requireRole('ADMIN','SA'), async (req, res) => {
  const u = req.user; const { id } = req.params;
  const { rows } = await q(
    `UPDATE franchisee_applications SET status='DOCS_VERIFIED'
     WHERE id=$1 AND status='SUBMITTED'
     RETURNING *`, [id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid state transition' });
  await logAction(id, u.id, 'VERIFY');
  res.json(toApp(rows[0]));
});

/** Approve (SA only) */
router.post('/applications/:id/approve', requireRole('SA'), async (req, res) => {
  const u = req.user; const { id } = req.params;
  const { rows } = await q(
    `UPDATE franchisee_applications SET status='APPROVED', is_locked=TRUE
     WHERE id=$1 AND status='DOCS_VERIFIED'
     RETURNING *`, [id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid state transition' });
  await logAction(id, u.id, 'APPROVE');
  res.json(toApp(rows[0]));
});

/** Reject (SA only) */
router.post('/applications/:id/reject', requireRole('SA'), async (req, res) => {
  const u = req.user; const { id } = req.params; const { notes } = req.body || {};
  const { rows } = await q(
    `UPDATE franchisee_applications SET status='REJECTED'
     WHERE id=$1 AND status IN ('SUBMITTED','DOCS_VERIFIED')
     RETURNING *`, [id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid state transition' });
  await logAction(id, u.id, 'REJECT', notes||null);
  res.json(toApp(rows[0]));
});

/** Issue credentials (SA only) → creates user + franchisee */
router.post('/applications/:id/issue-credentials', requireRole('SA'), async (req, res) => {
  const u = req.user; const { id } = req.params;

  const { rows: appRows } = await q(`SELECT * FROM franchisee_applications WHERE id=$1`, [id]);
  const app = appRows[0];
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (app.status !== 'APPROVED') return res.status(400).json({ error: 'Must be APPROVED' });

  const code = await generateFranchiseeCode();
  const username = code; // franchisee logs in with their code
  const plainPassword = `${code}@2025`; // policy: not modifiable by franchisee
  const hash = bcrypt.hashSync(plainPassword + PEPPER, 12);

  try {
    await q('BEGIN');

    const userIns = await q(
      `INSERT INTO users (username, password_hash, role, is_active)
       VALUES ($1,$2,'FRANCHISEE',TRUE) RETURNING id`,
      [username, hash]
    );

    const frIns = await q(
      `INSERT INTO franchisees
       (application_id, code, legal_name, gstin, pan, address_line1, address_line2, city, state, pincode, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [app.id, code, app.legal_name, app.gstin, app.pan, app.address_line1, app.address_line2, app.city, app.state, app.pincode, userIns.rows[0].id]
    );

    const upd = await q(
      `UPDATE franchisee_applications
       SET status='CREDENTIALS_ISSUED'
       WHERE id=$1 RETURNING *`, [id]
    );

    await logAction(id, u.id, 'ISSUE_CREDENTIALS', `username=${username}; password=system-set`);

    await q('COMMIT');
    return res.json({
      application: toApp(upd.rows[0]),
      franchisee: frIns.rows[0],
      credentials: { username, password: plainPassword } // deliver securely in SA/Admin screen
    });
  } catch (e) {
    await q('ROLLBACK');
    return res.status(500).json({ error: 'Failed to issue credentials', detail: String(e) });
  }
});

/** Activate franchisee (Admin/SA) — flips application to ACTIVE */
router.post('/applications/:id/activate', requireRole('ADMIN','SA'), async (req, res) => {
  const u = req.user; const { id } = req.params;
  const { rows: appRows } = await q(`SELECT status FROM franchisee_applications WHERE id=$1`, [id]);
  if (!appRows[0]) return res.status(404).json({ error: 'Not found' });
  if (appRows[0].status !== 'CREDENTIALS_ISSUED') return res.status(400).json({ error: 'Must be CREDENTIALS_ISSUED' });

  const { rows } = await q(
    `UPDATE franchisee_applications SET status='ACTIVE' WHERE id=$1 RETURNING *`, [id]
  );
  await logAction(id, u.id, 'ACTIVATE');
  res.json(toApp(rows[0]));
});

export default router;
