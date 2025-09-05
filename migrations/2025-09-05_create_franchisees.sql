-- 2025-09-05_create_franchisees.sql
-- Idempotent creation of `franchisees` with useful constraints.

CREATE TABLE IF NOT EXISTS public.franchisees (
  id               BIGSERIAL PRIMARY KEY,
  franchisee_id    TEXT UNIQUE NOT NULL,      -- e.g., TS-DL-DEL-001
  legal_name       TEXT NOT NULL,
  gstin            TEXT,
  pan              TEXT,
  state            TEXT,
  state_code       TEXT NOT NULL,             -- e.g., DL
  city             TEXT,
  city_code        TEXT NOT NULL,             -- e.g., DEL
  pincode          TEXT,
  address1         TEXT,
  address2         TEXT,
  phone            TEXT,
  email            TEXT,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  api_key          TEXT,                      -- reserved (optional future)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lowercased unique constraints (only where provided)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uq_franchisees_gstin_lower'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX uq_franchisees_gstin_lower ON public.franchisees ((lower(gstin))) WHERE gstin IS NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uq_franchisees_email_lower'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX uq_franchisees_email_lower ON public.franchisees ((lower(email))) WHERE email IS NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ix_franchisees_state_city'
  ) THEN
    EXECUTE 'CREATE INDEX ix_franchisees_state_city ON public.franchisees (state_code, city_code)';
  END IF;
END$$;

-- Trigger to maintain updated_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname='franchisees_set_updated_at'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION franchisees_set_updated_at() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at := NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    $fn$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='trg_franchisees_updated_at'
  ) THEN
    EXECUTE 'CREATE TRIGGER trg_franchisees_updated_at BEFORE UPDATE ON public.franchisees FOR EACH ROW EXECUTE FUNCTION franchisees_set_updated_at()';
  END IF;
END$$;
