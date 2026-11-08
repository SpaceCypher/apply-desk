-- Lessons the agent learns from its own runs, and per-site memory of what worked.
CREATE TABLE IF NOT EXISTS lessons (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope TEXT NOT NULL,                 -- 'platform:workday' or 'domain:acme.wd5.myworkdayjobs.com'
  trigger TEXT NOT NULL DEFAULT '',    -- short page signature it applies to (heading or control), optional
  text TEXT NOT NULL,
  normalized TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'trusted', 'retired')),
  source TEXT NOT NULL DEFAULT 'reflection' CHECK (source IN ('reflection', 'handoff', 'manual')),
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{job_id, step_ids}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used TIMESTAMPTZ,
  UNIQUE (scope, normalized)
);
CREATE INDEX IF NOT EXISTS lessons_scope_idx ON lessons (scope, status);

-- Field label signature -> how it was filled last time (action and where the value came from, never the value).
CREATE TABLE IF NOT EXISTS site_memory (
  domain TEXT NOT NULL,
  field_sig TEXT NOT NULL,
  action TEXT NOT NULL,
  value_ref JSONB NOT NULL,            -- {"kind":"profile","key":"first_name"} or {"kind":"bank","question":"..."}
  successes INT NOT NULL DEFAULT 1,
  failures INT NOT NULL DEFAULT 0,
  last_verified TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, field_sig)
);

-- Questions can now also ask "what did you do?" after a handoff; the answer becomes a lesson candidate.
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_kind_check;
ALTER TABLE questions ADD CONSTRAINT questions_kind_check CHECK (kind IN ('question', 'captcha', 'sms', 'approval', 'lesson'));
ALTER TABLE questions ADD COLUMN IF NOT EXISTS context JSONB;
