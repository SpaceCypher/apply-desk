import { pool } from "@/lib/db";

// Same rules as worker/lib/lessons.mjs validateLesson(): short, starts with an action verb, no destructive or
// submitting actions, no URLs, emails or long numbers.
const VERBS = /^(click|press|choose|select|type|fill|check|scroll|wait|use|open|close|dismiss|upload|expect|look|skip|pick|after|before|when|if|on)\b/i;
const FORBIDDEN = /withdraw|delete|remove (the )?application|cancel|pay(ment)?|bank|card|ssn|social security|submit|approve|ignore (the |all |previous )|instruction|always click|never ask|sponsor|salary|aadhaar|pan\b/i;
const PII = /https?:\/\/|www\.|@|\b\d{5,}\b|\+\d{6,}/i;

export function validateLesson(text: string): string | null {
  const t = text.trim();
  if (t.length < 12) return "too short";
  if (t.length > 160) return "too long";
  if (!VERBS.test(t)) return "must start with an action verb (Click, Press, Choose, Use...)";
  if (FORBIDDEN.test(t)) return "mentions a forbidden action or topic";
  if (PII.test(t)) return "contains a URL, email or long number";
  return null;
}

const normalize = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

// A handoff answer ("what did you do?") becomes a candidate lesson for that platform.
export async function lessonFromAnswer(questionId: number, answer: string) {
  const q = (await pool.query("SELECT job_id, context FROM questions WHERE id=$1 AND kind='lesson'", [questionId])).rows[0];
  if (!q) return null;
  const problem = validateLesson(answer);
  if (problem) return { stored: false, reason: problem };
  const scope = `platform:${q.context?.platform || "custom"}`;
  await pool.query(
    "INSERT INTO lessons (scope, text, normalized, source, evidence) VALUES ($1,$2,$3,'handoff',$4) ON CONFLICT (scope, normalized) DO NOTHING",
    [scope, answer.trim(), normalize(answer), JSON.stringify([{ job_id: q.job_id }])]);
  return { stored: true };
}
