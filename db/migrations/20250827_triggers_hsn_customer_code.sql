-- File: db/migrations/20250827_triggers_hsn_customer_code.sql
BEGIN;

-- Safety: ensure column exists & is NOT NULL (from Step 1.c); keep as-is if already set.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS hsn_code TEXT;
UPDATE invoices SET hsn_code = '3403.19.00' WHERE hsn_code IS NULL OR hsn_code = '';
ALTER TABLE invoices ALTER COLUMN hsn_code SET NOT NULL;

-- Ensure customer_code column exists & not null (you already have it, but harden)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS customer_code TEXT;
UPDATE invoices
SET customer_code = 'C' || LPAD(CAST(id AS TEXT), 6, '0')
WHERE customer_code IS NULL OR customer_code = '';
ALTER TABLE invoices ALTER COLUMN customer_code SET NOT NULL;

-- Unique index for customer_code (idempotent guard)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'ux_invoices_customer_code'
  ) THEN
    CREATE UNIQUE INDEX ux_invoices_customer_code ON invoices(customer_code);
  END IF;
END$$;

-- 1) BEFORE INSERT trigger to set default HSN if null/blank
CREATE OR REPLACE FUNCTION trg_invoices_set_default_hsn()
RETURNS trigger AS $$
BEGIN
  IF NEW.hsn_code IS NULL OR NEW.hsn_code = '' THEN
    NEW.hsn_code := '3403.19.00';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS before_insert_set_default_hsn ON invoices;
CREATE TRIGGER before_insert_set_default_hsn
BEFORE INSERT ON invoices
FOR EACH ROW
EXECUTE FUNCTION trg_invoices_set_default_hsn();

-- 2) AFTER INSERT trigger to set customer_code based on generated ID
CREATE OR REPLACE FUNCTION trg_invoices_set_customer_code()
RETURNS trigger AS $$
BEGIN
  IF NEW.customer_code IS NULL OR NEW.customer_code = '' THEN
    UPDATE invoices
      SET customer_code = 'C' || LPAD(CAST(NEW.id AS TEXT), 6, '0')
      WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS after_insert_set_customer_code ON invoices;
CREATE TRIGGER after_insert_set_customer_code
AFTER INSERT ON invoices
FOR EACH ROW
EXECUTE FUNCTION trg_invoices_set_customer_code();

COMMIT;
