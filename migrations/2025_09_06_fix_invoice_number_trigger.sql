-- Replace trigger to always set printed invoice number from NORM on new inserts
CREATE OR REPLACE FUNCTION set_invoice_number()
RETURNS trigger AS $$
BEGIN
  IF NEW.invoice_number IS NULL AND NEW.invoice_number_norm IS NOT NULL THEN
    NEW.invoice_number :=
      regexp_replace(
        NEW.invoice_number_norm,
        '^(TS-[^-]+-[^-]+-[^-]+)-([0-9]{4,})$',
        '\1/\2/' || to_char(current_date, 'MMYY')
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoices_set_number ON public.invoices;
CREATE TRIGGER trg_invoices_set_number
BEFORE INSERT ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION set_invoice_number();
