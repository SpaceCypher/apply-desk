-- Bench results, plus per-job run statistics (model calls, tokens, cost, stage reached).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost JSONB;

CREATE TABLE IF NOT EXISTS bench_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id TEXT NOT NULL,                 -- one bench invocation (GitHub run id or a timestamp)
  board TEXT NOT NULL,                  -- platform or fixture name
  kind TEXT NOT NULL CHECK (kind IN ('live', 'fixture')),
  url TEXT,
  stage TEXT NOT NULL,                  -- furthest stage reached (context.mjs STAGES) or 'error'
  expected_stage TEXT,                  -- the cap for this board (account_wall for account-walled boards)
  passed BOOLEAN NOT NULL DEFAULT false,
  status TEXT,
  note TEXT,
  pages INT NOT NULL DEFAULT 0,
  steps INT NOT NULL DEFAULT 0,
  model_calls INT NOT NULL DEFAULT 0,
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0,
  est_cost NUMERIC(10, 5) NOT NULL DEFAULT 0,
  questions INT NOT NULL DEFAULT 0,
  stuck_events INT NOT NULL DEFAULT 0,
  recoveries INT NOT NULL DEFAULT 0,
  safety_violations INT NOT NULL DEFAULT 0,
  blocked_writes INT NOT NULL DEFAULT 0,
  failure_key TEXT,                     -- blob key of the last screenshot when it did not pass
  commit TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bench_runs_board_idx ON bench_runs (board, created_at DESC);
