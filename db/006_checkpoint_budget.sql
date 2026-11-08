-- Checkpoint and resume: a job waiting for you no longer holds a runner.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS checkpoint JSONB;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN
  ('queued', 'running', 'needs_user', 'awaiting_approval', 'applied', 'failed', 'submission_unverified', 'closed', 'cancelled', 'manual', 'paused'));

-- Budgets: per application and per month (USD estimates from token counts).
INSERT INTO settings (key, value) VALUES
  ('max_minutes', '25'), ('max_tokens', '400000'), ('monthly_budget_usd', '20'), ('budget_alerted_month', 'null')
ON CONFLICT DO NOTHING;
