-- Backfill: franchisee_code, invoice_seq, invoice_number_norm, hsn_code
-- Safe for current small dataset; runs quickly.

-- 1) Copy franchisee_id -> franchisee_code if missing
UPDATE public.invoices
SET franchisee_code = franchisee_id
WHERE franchisee_code IS NULL
  AND franchisee_id IS NOT NULL;

-- 2) Extract 4-digit seq from existing Invoice No like FRID/####/MMYY
-- Examples: TS-DL-DEL-001/0105/0925
UPDATE public.invoices
SET invoice_seq = ((regexp_match(invoice_number, '^[A-Z0-9-]+/([0-9]{4})/[0-9]{4}$'))[1])::int
WHERE invoice_seq IS NULL
  AND invoice_number ~ '^[A-Z0-9-]+/[0-9]{4}/[0-9]{4}$';

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

-- 6) Helpful index for lookups (small table: regular CREATE is fine)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_invoices_franchisee_seq'
  ) THEN
    EXECUTE 'CREATE INDEX idx_invoices_franchisee_seq ON public.invoices (franchisee_code, invoice_seq)';
  END IF;
END$$;
