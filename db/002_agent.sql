-- Stage 2-5: answer bank, questions, documents, vault, inbox, settings, blobs.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_description TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS flags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS approval TEXT CHECK (approval IN ('approved', 'rejected'));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN
  ('queued', 'running', 'needs_user', 'awaiting_approval', 'applied', 'failed', 'submission_unverified', 'closed', 'cancelled', 'manual'));
DROP INDEX IF EXISTS jobs_queue_idx;
CREATE INDEX jobs_queue_idx ON jobs (created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS answer_bank (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question TEXT NOT NULL,
  normalized TEXT NOT NULL UNIQUE,
  answer TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Questions the agent could not answer. The worker polls for `answer`.
CREATE TABLE IF NOT EXISTS questions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL DEFAULT 'question' CHECK (kind IN ('question', 'captcha', 'sms', 'approval')),
  prompt TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  answer TEXT,
  telegram_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS questions_open_idx ON questions (created_at) WHERE answer IS NULL;

CREATE TABLE IF NOT EXISTS documents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('resume', 'cover_letter')),
  blob_key TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vault: password_enc and username_enc are AES-256-GCM (iv.tag.ciphertext, base64url).
CREATE TABLE IF NOT EXISTS credentials (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  username_enc TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  sender TEXT,
  subject TEXT,
  code TEXT,
  link TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
  ('default_mode', '"review"'), ('allowed_domains', '[]'), ('max_steps', '150'),
  ('kill_switch', 'false'), ('auto_unlocked', 'false')
ON CONFLICT DO NOTHING;

-- Screenshots and PDFs when R2 is not configured.
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
