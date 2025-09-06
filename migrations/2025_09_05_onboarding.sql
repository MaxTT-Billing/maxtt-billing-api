-- 1) Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'application_status') THEN
    CREATE TYPE application_status AS ENUM (
      'DRAFT','SUBMITTED','REQUESTED_CHANGES',
      'DOCS_VERIFIED','APPROVED','REJECTED',
      'CREDENTIALS_ISSUED','ACTIVE','SUSPENDED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'role_type') THEN
    CREATE TYPE role_type AS ENUM ('SA','ADMIN','FRANCHISEE');
  END IF;
END$$;

-- 2) Users (if not already present)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,         -- e.g. franchisee login id
  password_hash TEXT NOT NULL,
  role role_type NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) Franchisee applications
CREATE TABLE IF NOT EXISTS franchisee_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status application_status NOT NULL DEFAULT 'DRAFT',
  created_by UUID NOT NULL REFERENCES users(id),
  legal_name TEXT NOT NULL,              -- legal entity name
  trade_name TEXT,                       -- display name
  contact_person TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  gstin TEXT NOT NULL,
  pan TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  pincode TEXT NOT NULL,
  notes TEXT,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE, -- locks core KYC fields post approval
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fr_app_status ON franchisee_applications(status);
CREATE INDEX IF NOT EXISTS idx_fr_app_email ON franchisee_applications(email);

-- Uniqueness while excluding rejected apps to reduce conflicts
CREATE UNIQUE INDEX IF NOT EXISTS uq_fr_app_gstin_active
  ON franchisee_applications(gstin)
  WHERE status NOT IN ('REJECTED');

CREATE UNIQUE INDEX IF NOT EXISTS uq_fr_app_pan_active
  ON franchisee_applications(pan)
  WHERE status NOT IN ('REJECTED');

-- 4) Document uploads (references stored location, e.g. S3/Vercel blob)
CREATE TABLE IF NOT EXISTS application_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES franchisee_applications(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,        -- 'GST','PAN','ADDRESS_PROOF' etc.
  file_url TEXT NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5) Approval/audit log
CREATE TABLE IF NOT EXISTS application_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES franchisee_applications(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,           -- SUBMIT, VERIFY, APPROVE, REJECT, REQUEST_CHANGES, ISSUE_CREDENTIALS, ACTIVATE, SUSPEND
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6) Franchisee master
CREATE TABLE IF NOT EXISTS franchisees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID UNIQUE REFERENCES franchisee_applications(id),
  code TEXT UNIQUE NOT NULL,       -- e.g. MAXTT-001, or MAXTT-DEMO-001 (prefix env-driven)
  legal_name TEXT NOT NULL,
  gstin TEXT NOT NULL,
  pan TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  pincode TEXT NOT NULL,
  user_id UUID UNIQUE NOT NULL REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7) Franchisee code sequence
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='franchisee_code_seq') THEN
    CREATE SEQUENCE franchisee_code_seq START 1 INCREMENT 1 MINVALUE 1;
  END IF;
END$$;

-- 8) Updated_at trigger for applications
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fr_app_updated ON franchisee_applications;
CREATE TRIGGER trg_fr_app_updated
BEFORE UPDATE ON franchisee_applications
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 9) Immutability lock (post-approval)
CREATE OR REPLACE FUNCTION enforce_immutable_fields()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_locked = TRUE THEN
    IF NEW.legal_name <> OLD.legal_name
      OR NEW.gstin <> OLD.gstin
      OR NEW.pan <> OLD.pan
      OR NEW.address_line1 <> OLD.address_line1
      OR COALESCE(NEW.address_line2,'') <> COALESCE(OLD.address_line2,'')
      OR NEW.city <> OLD.city
      OR NEW.state <> OLD.state
      OR NEW.pincode <> OLD.pincode
    THEN
      RAISE EXCEPTION 'Core KYC fields are locked and cannot be edited after approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fr_app_immutable ON franchisee_applications;
CREATE TRIGGER trg_fr_app_immutable
BEFORE UPDATE ON franchisee_applications
FOR EACH ROW EXECUTE FUNCTION enforce_immutable_fields();
