-- File: db/migrations/20250827_fix_customer_code_trigger.sql
BEGIN;

-- Drop the AFTER trigger and function (if they exist)
DROP TRIGGER IF EXISTS after_insert_set_customer_code ON invoices;
DROP FUNCTION IF EXISTS trg_invoices_set_customer_code();

-- BEFORE INSERT trigger sets customer_code using NEW.id
CREATE OR REPLACE FUNCTION trg_invoices_set_customer_code_before()
RETURNS trigger AS $$
BEGIN
  IF NEW.customer_code IS NULL OR NEW.customer_code = '' THEN
    -- Assumes id is populated from sequence default before BEFORE trigger runs (standard in PG)
    IF NEW.id IS NULL THEN
      -- Force id generation if client did not pass it (typical)
      NEW.id := nextval(pg_get_serial_sequence('invoices','id'));
    END IF;
    NEW.customer_code := 'C' || LPAD(CAST(NEW.id AS TEXT), 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS before_insert_set_customer_code ON invoices;
CREATE TRIGGER before_insert_set_customer_code
BEFORE INSERT ON invoices
FOR EACH ROW
EXECUTE FUNCTION trg_invoices_set_customer_code_before();

COMMIT;
