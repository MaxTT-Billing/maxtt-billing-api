-- Adds signature + GPS columns if they don't already exist.
-- Safe to run multiple times.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices' AND column_name='customer_signature'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN customer_signature text;            -- base64 PNG (data URL or raw base64)
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices' AND column_name='signed_at'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN signed_at timestamptz;              -- when customer signed
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices' AND column_name='consent_signature'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN consent_signature text;             -- base64 PNG (consent/indemnity)
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices' AND column_name='consent_signed_at'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN consent_signed_at timestamptz;      -- when consent was signed
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices' AND column_name='gps_lat'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN gps_lat double precision;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='invoices' AND column_name='gps_lng'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN gps_lng double precision;
  END IF;
END $$;
