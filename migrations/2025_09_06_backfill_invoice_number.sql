-- Backfill for existing rows: convert NORM -> printed style: TS-...-NNNN  =>  TS-.../NNNN/MMYY
UPDATE public.invoices
SET invoice_number = regexp_replace(
        invoice_number_norm,
        '^(TS-[^-]+-[^-]+-[^-]+)-([0-9]{4,})$',
        '\1/\2/' || to_char(current_date, 'MMYY')
    )
WHERE invoice_number IS NULL
  AND invoice_number_norm ~ '^(TS-[^-]+-[^-]+-[^-]+)-([0-9]{4,})$';
