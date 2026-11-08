-- $1 is the worker ID, $2 is the lease interval. Claims one queued job of any mode.
WITH candidate AS (
  SELECT id FROM jobs
  WHERE (status = 'queued' OR (status = 'running' AND lease_until < now()))
    AND submit_attempted_at IS NULL
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs
SET status = 'running', claimed_by = $1, lease_until = now() + $2::interval, updated_at = now()
FROM candidate
WHERE jobs.id = candidate.id
RETURNING jobs.*;
