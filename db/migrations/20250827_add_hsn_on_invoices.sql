-- File: db/migrations/20250827_add_hsn_on_invoices.sql
BEGIN;

-- 1) Add column (nullable first)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS hsn_code TEXT;

-- 2) Backfill existing rows (Sealant default)
UPDATE invoices
SET hsn_code = '3403.19.00'
WHERE hsn_code IS NULL OR hsn_code = '';

-- 3) Enforce NOT NULL
ALTER TABLE invoices
  ALTER COLUMN hsn_code SET NOT NULL;

COMMIT;
