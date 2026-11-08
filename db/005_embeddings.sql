-- Answer-bank embeddings for matching differently worded questions. Stored as a plain float array so this works
-- on any Postgres (no pgvector needed for a few hundred answers; similarity is computed in the worker).
ALTER TABLE answer_bank ADD COLUMN IF NOT EXISTS embedding REAL[];
ALTER TABLE answer_bank ADD COLUMN IF NOT EXISTS embedding_model TEXT;
