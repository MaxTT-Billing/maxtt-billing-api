ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_seq integer,
  ADD COLUMN IF NOT EXISTS franchisee_code text,
  ADD COLUMN IF NOT EXISTS invoice_number_norm text,
  ADD COLUMN IF NOT EXISTS customer_code text,
  ADD COLUMN IF NOT EXISTS hsn_code varchar(8);
