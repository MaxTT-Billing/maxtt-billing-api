-- Stock-lock groundwork: installations table + housekeeping
-- Creates a durable record to persist the "start check" snapshot
-- and allow in-progress installs to complete even if stock dips later.

BEGIN;

-- 1) Safe helper: updated_at auto-touch
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2) installations table
-- Note: using BIGSERIAL (no uuid extension dependency).
-- status constrained to ('started','completed','cancelled').
CREATE TABLE IF NOT EXISTS installations (
  id BIGSERIAL PRIMARY KEY,
  franchisee_id TEXT NOT NULL,
  stock_check_litres_snapshot NUMERIC(10,2) NOT NULL,
  stock_check_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  allowed_to_proceed BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started','completed','cancelled')),
  used_litres NUMERIC(10,2),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_installations_franchisee
  ON installations (franchisee_id);

CREATE INDEX IF NOT EXISTS idx_installations_status
  ON installations (status);

CREATE INDEX IF NOT EXISTS idx_installations_created_at
  ON installations (created_at);

-- 4) Touch updated_at on row updates
DROP TRIGGER IF EXISTS trg_installations_updated_at ON installations;
CREATE TRIGGER trg_installations_updated_at
BEFORE UPDATE ON installations
FOR EACH ROW
EXECUTE PROCEDURE set_updated_at();

COMMIT;
