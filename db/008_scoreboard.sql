-- Engine scoreboard: real postings with an answer key (what each field should hold), and one row per engine x
-- posting x run. Keys hold personal answers, so they live here, never in the repo.
CREATE TABLE IF NOT EXISTS scoreboard_postings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  key JSONB NOT NULL DEFAULT '{"entries": []}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  spare BOOLEAN NOT NULL DEFAULT false,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scoreboard_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  platform TEXT NOT NULL,
  posting_id BIGINT REFERENCES scoreboard_postings(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 1,
  reached_submit BOOLEAN NOT NULL DEFAULT false,
  stage TEXT,
  fields_total INT NOT NULL DEFAULT 0,
  fields_correct INT NOT NULL DEFAULT 0,
  wrong JSONB NOT NULL DEFAULT '[]'::jsonb,
  resume_ok BOOLEAN,
  steps INT NOT NULL DEFAULT 0,
  seconds NUMERIC NOT NULL DEFAULT 0,
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0,
  cost NUMERIC,
  questions INT NOT NULL DEFAULT 0,
  writes JSONB NOT NULL DEFAULT '[]'::jsonb,
  note TEXT,
  commit TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scoreboard_runs_platform_idx ON scoreboard_runs (platform, engine, created_at DESC);
