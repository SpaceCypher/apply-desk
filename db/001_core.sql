CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  application_url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'review', 'auto')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'needs_user', 'applied', 'failed', 'submission_unverified', 'closed')),
  submit_attempted_at TIMESTAMPTZ,
  receipt JSONB,
  claimed_by TEXT,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_steps (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  screenshot_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS profile (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
