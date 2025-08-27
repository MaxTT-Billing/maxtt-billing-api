-- File: db/migrations/20250827_add_hsn_customer_code.sql
BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS customer_code VARCHAR(20);

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(20);

UPDATE invoice_items
SET hsn_code = CASE
  WHEN product_name ILIKE '%pump%' THEN '8413.20'
  ELSE '3403.19.00'
END
WHERE hsn_code IS NULL;

UPDATE invoices
SET customer_code = 'C' || LPAD(CAST(id AS TEXT), 6, '0')
WHERE customer_code IS NULL;

ALTER TABLE invoices
  ALTER COLUMN customer_code SET NOT NULL;

ALTER TABLE invoice_items
  ALTER COLUMN hsn_code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_invoices_customer_code_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_invoices_customer_code_unique ON invoices(customer_code);
  END IF;
END$$;

COMMIT;
