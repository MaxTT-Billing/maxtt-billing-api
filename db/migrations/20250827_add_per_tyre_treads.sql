BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tread_fl_mm NUMERIC,
  ADD COLUMN IF NOT EXISTS tread_fr_mm NUMERIC,
  ADD COLUMN IF NOT EXISTS tread_rl_mm NUMERIC,
  ADD COLUMN IF NOT EXISTS tread_rr_mm NUMERIC;

UPDATE invoices
SET
  tread_fl_mm = COALESCE(tread_fl_mm, tread_depth_mm),
  tread_fr_mm = COALESCE(tread_fr_mm, tread_depth_mm),
  tread_rl_mm = COALESCE(tread_rl_mm, tread_depth_mm),
  tread_rr_mm = COALESCE(tread_rr_mm, tread_depth_mm)
WHERE tread_depth_mm IS NOT NULL;

COMMIT;
