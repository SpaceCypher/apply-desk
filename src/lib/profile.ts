// Validates and trims the profile document so the database only ever holds the expected shape.
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = <T,>(v: unknown, max: number, f: (x: Record<string, unknown>, i: number) => T): T[] =>
  Array.isArray(v) ? v.slice(0, max).filter(x => x && typeof x === "object").map((x, i) => f(x as Record<string, unknown>, i)) : [];

export const SENSITIVE_KEYS = ["gender", "race", "veteran", "disability", "birth_date", "citizenship", "religion", "orientation"];
const IDENTITY = ["first_name", "last_name", "email", "phone", "location", "linkedin", "github", "portfolio"];

export function cleanProfile(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of IDENTITY) if (typeof data[key] === "string") out[key] = str(data[key]);
  out.education = list(data.education, 10, e => ({ school: str(e.school), degree: str(e.degree), start: str(e.start, 30), end: str(e.end, 30), gpa: str(e.gpa, 30) }));
  out.experiences = list(data.experiences, 20, (e, i) => ({
    id: str(e.id, 40) || `exp${i + 1}`, company: str(e.company), title: str(e.title), start: str(e.start, 30), end: str(e.end, 30),
    bullets: (Array.isArray(e.bullets) ? e.bullets : []).slice(0, 12).map(b => str(b, 600)).filter(Boolean),
  }));
  out.projects = list(data.projects, 20, (p, i) => ({
    id: str(p.id, 40) || `proj${i + 1}`, name: str(p.name), short: str(p.short, 300), medium: str(p.medium, 800), long: str(p.long, 2000),
    tech: (Array.isArray(p.tech) ? p.tech : []).slice(0, 20).map(t => str(t, 40)).filter(Boolean),
  }));
  out.skills = list(data.skills, 80, s => ({ name: str(s.name, 60), level: ["beginner", "intermediate", "advanced", "expert"].includes(str(s.level, 20)) ? str(s.level, 20) : "intermediate" })).filter(s => s.name);
  out.writing_samples = (Array.isArray(data.writing_samples) ? data.writing_samples : []).slice(0, 5).map(s => str(s, 5000)).filter(Boolean);
  out.master_resume = str(data.master_resume, 20000);
  out.resume_tex = str(data.resume_tex, 50000);
  const prefs = (data.preferences && typeof data.preferences === "object" ? data.preferences : {}) as Record<string, unknown>;
  out.preferences = Object.fromEntries(["roles", "locations", "remote", "relocation", "salary", "notice_period"].map(k => [k, str(prefs[k], 300)]));
  const sens = (data.sensitive && typeof data.sensitive === "object" ? data.sensitive : {}) as Record<string, { value?: unknown; mode?: unknown }>;
  out.sensitive = Object.fromEntries(SENSITIVE_KEYS.filter(k => sens[k] && str(sens[k].value)).map(k => [k, { value: str(sens[k].value, 100), mode: sens[k].mode === "answer" ? "answer" : "ask" }]));
  out.stealth_rule = str(data.stealth_rule, 1000);
  return out;
}
