# How to run 2025_09_09_invoice_number.sql on MAXTT-BILLING-DB

1) Open pgAdmin (Render → maxtt-billing-db → Apps → pgAdmin → Browser).
2) Connect using your DB host/port/db/user/password.
3) Right-click the database `maxtt_billing_db` → Query Tool.
4) Paste the full SQL from migrations/2025_09_09_invoice_number.sql and run.
5) Verify:
   SELECT id, created_at, invoice_number_norm, invoice_number
   FROM invoices ORDER BY id DESC LIMIT 10;
   → `invoice_number` should be like TS-HR-GGM-001/0925/0019.
