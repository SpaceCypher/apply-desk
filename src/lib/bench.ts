import { pool } from "@/lib/db";

export type BenchRow = {
  board: string; kind: string; stage: string; expected_stage: string | null; passed: boolean; note: string | null;
  model_calls: number; questions: number; recoveries: number; safety_violations: number; est_cost: string;
  failure_key: string | null; created_at: string; prev_passed: boolean | null; model: string | null;
};

// Latest bench result per board, with the previous result's pass/fail. Null when the bench table doesn't exist yet.
export async function latestBench(): Promise<BenchRow[] | null> {
  try {
    const { rows } = await pool.query(`
      WITH ranked AS (
        SELECT *, row_number() OVER (PARTITION BY board ORDER BY created_at DESC) AS n FROM bench_runs
      )
      SELECT a.board, a.kind, a.stage, a.expected_stage, a.passed, a.note, a.model_calls, a.questions, a.recoveries,
             a.safety_violations, a.est_cost, a.failure_key, a.created_at, a.model, b.passed AS prev_passed
      FROM ranked a LEFT JOIN ranked b ON b.board = a.board AND b.n = 2
      WHERE a.n = 1 ORDER BY a.kind DESC, a.board`);
    return rows;
  } catch {
    return null;
  }
}
