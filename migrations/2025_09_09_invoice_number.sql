-- Add column if it doesn't exist
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_number TEXT;

-- Backfill existing rows (e.g., TS-HR-GGM-001-0019  ->  TS-HR-GGM-001/0925/0019)
UPDATE invoices
SET invoice_number =
  regexp_replace(
    invoice_number_norm,
    '-(\\d{4})$',
    '/' || to_char(COALESCE(created_at, now()), 'MMYY') || '/\1'
  )
WHERE invoice_number IS NULL
  AND invoice_number_norm IS NOT NULL;

-- Function to auto-set invoice_number on insert/update
CREATE OR REPLACE FUNCTION public.fn_set_invoice_number()
RETURNS trigger AS $$
BEGIN
  IF NEW.invoice_number IS NULL OR NEW.invoice_number = '' THEN
    IF NEW.invoice_number_norm IS NOT NULL THEN
      NEW.invoice_number :=
        regexp_replace(
          NEW.invoice_number_norm,
          '-(\\d{4})$',
          '/' || to_char(COALESCE(NEW.created_at, now()), 'MMYY') || '/\1'
        );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: keep invoice_number in sync when creating or when norm/date changes
DROP TRIGGER IF EXISTS trg_set_invoice_number ON invoices;
CREATE TRIGGER trg_set_invoice_number
BEFORE INSERT OR UPDATE OF invoice_number_norm, created_at ON invoices
FOR EACH ROW
EXECUTE FUNCTION public.fn_set_invoice_number();

-- Optional (uncomment only if you guarantee uniqueness)
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_invoice_number ON invoices (invoice_number);
