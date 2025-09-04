-- Backfill v2: auto-detect invoice number column name
-- Fills: franchisee_code, invoice_seq, invoice_number_norm, hsn_code
-- Safe and idempotent.

-- 1) Copy franchisee_id -> franchisee_code if missing
UPDATE public.invoices
SET franchisee_code = franchisee_id
WHERE franchisee_code IS NULL
  AND franchisee_id IS NOT NULL;

-- 2) Try to extract 4-digit seq from whatever invoice-number column exists
DO $$
DECLARE
  inv_col text;
BEGIN
  SELECT column_name
  INTO inv_col
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name='invoices'
    AND lower(column_name) IN ('invoice_number','invoice_no','inv_no','bill_no','invoice')
  ORDER BY
    CASE lower(column_name)
      WHEN 'invoice_number' THEN 1
      WHEN 'invoice_no' THEN 2
      WHEN 'inv_no' THEN 3
      WHEN 'bill_no' THEN 4
      WHEN 'invoice' THEN 5
      ELSE 6
    END
  LIMIT 1;

  IF inv_col IS NOT NULL THEN
    EXECUTE format($sql$
      UPDATE public.invoices
      SET invoice_seq = ((regexp_match(%1$I, '^[A-Z0-9-]+/([0-9]{4})/[0-9]{4}$'))[1])::int
      WHERE invoice_seq IS NULL
        AND %1$I ~ '^[A-Z0-9-]+/[0-9]{4}/[0-9]{4}$';
    $sql$, inv_col);
  END IF;
END$$;

-- 3) For any still NULL, assign per-franchisee by creation time
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(franchisee_id, franchisee_code, 'UNKNOWN')
      ORDER BY COALESCE(created_at, now()), id
    ) AS rn
  FROM public.invoices
  WHERE invoice_seq IS NULL
)
UPDATE public.invoices i
SET invoice_seq = r.rn
FROM ranked r
WHERE i.id = r.id;

-- 4) Set normalized number: FRANCHISEE_CODE-#### (display/lookup key)
UPDATE public.invoices
SET invoice_number_norm = franchisee_code || '-' || LPAD(invoice_seq::text, 4, '0')
WHERE invoice_number_norm IS NULL
  AND franchisee_code IS NOT NULL
  AND invoice_seq IS NOT NULL;

-- 5) Default HSN for older rows where missing
UPDATE public.invoices
SET hsn_code = '35069999'
WHERE hsn_code IS NULL;

-- 6) Helpful index for lookups
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_invoices_franchisee_seq'
  ) THEN
    EXECUTE 'CREATE INDEX idx_invoices_franchisee_seq ON public.invoices (franchisee_code, invoice_seq)';
  END IF;
END$$;
