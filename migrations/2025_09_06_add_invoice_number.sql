-- Adds a printed invoice number column the API can auto-fill
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_number TEXT;

-- Helpful (non-unique) index for lookups
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number
  ON public.invoices (invoice_number);
