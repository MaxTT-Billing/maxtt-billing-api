-- Trigger to auto-populate invoice_number if missing
CREATE OR REPLACE FUNCTION set_invoice_number()
RETURNS trigger AS $$
BEGIN
  IF NEW.invoice_number IS NULL AND NEW.invoice_number_norm IS NOT NULL THEN
    -- Append MMYY automatically (last 4 chars of norm)
    NEW.invoice_number := NEW.invoice_number_norm || '/' ||
                          TO_CHAR(CURRENT_DATE, 'MMYY');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoices_set_number ON public.invoices;
CREATE TRIGGER trg_invoices_set_number
BEFORE INSERT ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION set_invoice_number();
