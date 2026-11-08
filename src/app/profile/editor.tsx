"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Chips } from "../ui/chips";
import { CircleAlert, Download, Plus, RotateCcw, Trash2, Upload } from "../ui/icons";
import { PageHeader } from "../ui/empty";
import { Segmented } from "../ui/segmented";
import { useToast } from "../ui/toast";
import { ListEditor, TextList, type SetList } from "./list-editor";

type P = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Education = { school: string; degree: string; start: string; end: string; gpa: string };
type Experience = { id: string; company: string; title: string; start: string; end: string; bullets: string[] };
type Project = { id: string; name: string; short: string; medium: string; long: string; tech: string[] };
type Skill = { name: string; level: string };

const IDENTITY: { key: string; label: string; type?: string; auto?: string; placeholder?: string }[] = [
  { key: "first_name", label: "First name", auto: "given-name" },
  { key: "last_name", label: "Last name", auto: "family-name" },
  { key: "email", label: "Email", type: "email", auto: "email", placeholder: "The job inbox address" },
  { key: "phone", label: "Phone", type: "tel", auto: "tel", placeholder: "+91 …" },
  { key: "location", label: "City", auto: "address-level2", placeholder: "Bengaluru, India" },
  { key: "linkedin", label: "LinkedIn", type: "url", placeholder: "https://linkedin.com/in/…" },
  { key: "github", label: "GitHub", type: "url", placeholder: "https://github.com/…" },
  { key: "portfolio", label: "Portfolio", type: "url", placeholder: "https://…" },
];
const PREFS: [string, string, string][] = [
  ["roles", "Target roles", "Software engineer, backend intern"], ["locations", "Locations", "Bengaluru, remote"],
  ["remote", "Remote preference", "Remote or hybrid"], ["relocation", "Open to relocation", "Yes, within India"],
  ["salary", "Salary range", "Expected range"], ["notice_period", "Notice period", "Available from June 2027"],
];
const SENSITIVE: [string, string][] = [
  ["gender", "Gender"], ["race", "Race / ethnicity"], ["veteran", "Veteran status"], ["disability", "Disability"],
  ["birth_date", "Date of birth"], ["citizenship", "Citizenship / visa"], ["religion", "Religion"], ["orientation", "Sexual orientation"],
];
const LEVELS = ["beginner", "intermediate", "advanced", "expert"];
const SECTIONS = [
  ["identity", "Identity"], ["education", "Education"], ["experience", "Experience"], ["projects", "Projects"], ["skills", "Skills"],
  ["resume", "Resume & writing"], ["preferences", "Preferences"], ["sensitive", "Sensitive answers"], ["stealth", "Stealth rule"],
] as const;

const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export default function Editor() {
  const toast = useToast();
  const [p, setP] = useState<P | null>(null);
  const [saved, setSaved] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = p !== null && JSON.stringify(p) !== saved;

  const show = useCallback((fields: P) => { setP(fields); setSaved(JSON.stringify(fields)); }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/profile").then(r => (r.ok ? r.json() : Promise.reject())).then(({ fields }) => { if (live) { show(fields || {}); setLoadError(false); } })
      .catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, [reload, show]);

  async function put(body: P) {
    const r = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (r?.ok) show((await r.json()).fields);
    return !!r?.ok;
  }

  const save = useCallback(async () => {
    if (!p || busy) return;
    setBusy(true);
    const ok = await put(p);
    setBusy(false);
    toast(ok ? "Profile saved." : "Couldn't save. Your edits are still here; try again.", ok ? undefined : { tone: "danger" });
  }, [p, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd+S saves; leaving with unsaved edits asks first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (dirty) save(); } };
    const onLeave = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("keydown", onKey); window.addEventListener("beforeunload", onLeave);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onLeave); };
  }, [dirty, save]);

  // Imports a JSON file: profile fields (or the {fields} shape GET returns) plus an optional "answers" list for the answer bank.
  // Keys missing from the file keep their saved values; unsaved edits on this page are replaced.
  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !p) return;
    let data: P;
    try { data = JSON.parse(await file.text()); } catch { return toast("That file isn't valid JSON.", { tone: "danger" }); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return toast("Expected a JSON object.", { tone: "danger" });
    const { answers = [], ...rest } = data;
    const fields: P = rest.fields && typeof rest.fields === "object" ? rest.fields : rest;
    const base = JSON.parse(saved || "{}");
    const merged = { ...base, ...fields, preferences: { ...base.preferences, ...fields.preferences }, sensitive: { ...base.sensitive, ...fields.sensitive } };
    if (!await put(merged)) return toast("Couldn't save the imported profile.", { tone: "danger" });
    let added = 0;
    for (const a of Array.isArray(answers) ? answers : []) {
      const r = await fetch("/api/answers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: a?.question, answer: a?.answer }) }).catch(() => null);
      if (r?.ok) added++;
    }
    const skipped = (Array.isArray(answers) ? answers.length : 0) - added;
    toast(`Profile imported. ${added} answer${added === 1 ? "" : "s"} added${skipped ? `, ${skipped} skipped` : ""}.`);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(JSON.parse(saved || "{}"), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "apply-desk-profile.json"; a.click();
    URL.revokeObjectURL(a.href);
  }

  const header = <PageHeader title="Profile" description="The single source of truth. The agent never states a fact that isn't here."
    actions={<>
      <button type="button" className="btn btn--secondary" disabled={!p} onClick={() => fileInput.current?.click()}><Upload size={14} />Import</button>
      <button type="button" className="btn btn--secondary" disabled={!p} onClick={exportJson}><Download size={14} />Export</button>
      <input ref={fileInput} type="file" accept="application/json,.json" onChange={upload} hidden aria-label="Profile file" />
    </>} />

  if (loadError) return <div className="page">{header}
    <div className="callout callout--danger" role="alert"><CircleAlert size={16} /><span className="spacer">Couldn&apos;t load your profile.</span>
      <button className="btn btn--secondary btn--sm" onClick={() => setReload(n => n + 1)}><RotateCcw size={12} />Retry</button></div></div>;
  if (!p) return <div className="page">{header}<div className="stack">{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 96 }} />)}</div></div>;

  const set = (k: string, v: unknown) => setP(c => ({ ...c, [k]: v }));
  const setIn = (group: string, k: string, v: unknown) => setP(c => ({ ...c, [group]: { ...(c?.[group] || {}), [k]: v } }));
  function listSetter<T>(key: string): SetList<T> { return fn => setP(c => ({ ...c, [key]: fn(arr<T>(c?.[key])) })); }
  const skills = arr<Skill>(p.skills);

  return <div className="page">
    {header}
    <div className="editor">
      <nav className="editor__nav" aria-label="Profile sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
      <form onSubmit={e => { e.preventDefault(); save(); }} style={{ minWidth: 0 }}>
        <Section id="identity" title="Identity" hint="Used to fill standard fields directly, without asking the model.">
          <div className="grid-2">{IDENTITY.map(f => <div className="field" key={f.key}>
            <label className="field__label" htmlFor={f.key}>{f.label}</label>
            <input id={f.key} className="input" type={f.type || "text"} autoComplete={f.auto || "off"} placeholder={f.placeholder} value={p[f.key] || ""} onChange={e => set(f.key, e.target.value)} />
          </div>)}</div>
        </Section>

        <Section id="education" title="Education">
          <ListEditor<Education> items={arr(p.education)} setItems={listSetter("education")} noun="education" addLabel="Add education" max={10}
            title={e => [e.degree, e.school].filter(Boolean).join(" · ")}
            create={() => ({ school: "", degree: "", start: "", end: "", gpa: "" })}
            render={(e, update) => <>
              <div className="grid-2">
                <Field label="School" value={e.school} onChange={v => update({ school: v })} placeholder="State University" />
                <Field label="Degree" value={e.degree} onChange={v => update({ degree: v })} placeholder="B.Tech, Computer Science" />
              </div>
              <div className="grid-3">
                <Field label="Start" value={e.start} onChange={v => update({ start: v })} placeholder="2023" />
                <Field label="End" value={e.end} onChange={v => update({ end: v })} placeholder="June 2027" />
                <Field label="GPA" optional value={e.gpa} onChange={v => update({ gpa: v })} placeholder="8.6 / 10" />
              </div>
            </>} />
        </Section>

        <Section id="experience" title="Experience" hint="Write several bullet variants per role. The agent picks and reorders them; it never invents new ones.">
          <ListEditor<Experience> items={arr(p.experiences)} setItems={listSetter("experiences")} noun="role" addLabel="Add role" max={20}
            title={e => [e.title, e.company].filter(Boolean).join(" · ")}
            create={() => ({ id: uid("exp"), company: "", title: "", start: "", end: "", bullets: [""] })}
            render={(e, update) => <>
              <div className="grid-2">
                <Field label="Title" value={e.title} onChange={v => update({ title: v })} placeholder="Software Engineering Intern" />
                <Field label="Company" value={e.company} onChange={v => update({ company: v })} />
                <Field label="Start" value={e.start} onChange={v => update({ start: v })} placeholder="May 2025" />
                <Field label="End" value={e.end} onChange={v => update({ end: v })} placeholder="Present" />
              </div>
              <div className="field"><span className="field__label">Bullets</span>
                <TextList values={arr<string>(e.bullets)} onChange={v => update({ bullets: v })} label="Bullet" max={12} addLabel="Add bullet"
                  placeholder="Built … with … which cut … by …" /></div>
            </>} />
        </Section>

        <Section id="projects" title="Projects" hint="Short is one line for compact forms; long is for “tell us about a project” questions.">
          <ListEditor<Project> items={arr(p.projects)} setItems={listSetter("projects")} noun="project" addLabel="Add project" max={20}
            title={x => x.name}
            create={() => ({ id: uid("proj"), name: "", short: "", medium: "", long: "", tech: [] })}
            render={(x, update) => <>
              <Field label="Name" value={x.name} onChange={v => update({ name: v })} />
              <Field label="Short description" value={x.short} onChange={v => update({ short: v })} hint="One line" />
              <Field label="Medium description" optional multiline rows={3} value={x.medium} onChange={v => update({ medium: v })} />
              <Field label="Long description" optional multiline rows={5} value={x.long} onChange={v => update({ long: v })} />
              <div className="field"><span className="field__label">Tech</span>
                <Chips label="Add technology" values={arr<string>(x.tech)} onChange={v => update({ tech: v })} placeholder="Type and press Enter" /></div>
            </>} />
        </Section>

        <Section id="skills" title="Skills" hint="Honest levels. The resume only lists skills that are here.">
          {skills.length > 0 && <div className="stack-sm">
            {skills.map((s, i) => <div className="skill-row" key={i}>
              <input className="input" aria-label={`Skill ${i + 1}`} value={s.name} onChange={e => listSetter<Skill>("skills")(l => l.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
              <select className="select" aria-label={`Level for ${s.name || "skill"}`} value={s.level || "intermediate"} onChange={e => listSetter<Skill>("skills")(l => l.map((x, k) => (k === i ? { ...x, level: e.target.value } : x)))}>
                {LEVELS.map(l => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
              </select>
              <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${s.name || "skill"}`} onClick={() => listSetter<Skill>("skills")(l => l.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
            </div>)}
          </div>}
          <button type="button" className="btn btn--secondary add-btn" onClick={() => listSetter<Skill>("skills")(l => [...l, { name: "", level: "intermediate" }])}><Plus size={14} />Add skill</button>
        </Section>

        <Section id="resume" title="Resume & writing">
          <div className="stack">
            <Field label="Master resume" hint="Plain text. Used as the source when there's no LaTeX template." multiline rows={10} value={p.master_resume || ""} onChange={v => set("master_resume", v)} />
            <Field label="Resume LaTeX" optional hint="Your own .tex (Jake's resume macros). When set, the resume is this file, tailored per job and compiled with pdfLaTeX." multiline code rows={10} value={p.resume_tex || ""} onChange={v => set("resume_tex", v)} />
            <div className="field"><span className="field__label">Writing samples</span>
              <span className="field__hint">Three to five pieces in your own voice. Used only to match tone in cover letters.</span>
              <TextList values={arr<string>(p.writing_samples)} onChange={v => set("writing_samples", v)} label="Writing sample" rows={5} max={5} addLabel="Add sample" />
            </div>
          </div>
        </Section>

        <Section id="preferences" title="Job preferences">
          <div className="grid-2">{PREFS.map(([k, label, ph]) => <Field key={k} label={label} placeholder={ph} value={p.preferences?.[k] || ""} onChange={v => setIn("preferences", k, v)} />)}</div>
        </Section>

        <Section id="sensitive" title="Sensitive answers" hint="Stored here and only sent to the model when a form field asks. “Ask every time” always pauses and messages you. Empty rows are never answered.">
          <div className="table-wrap" style={{ overflowX: "auto" }}><table className="table">
            <thead><tr><th>Question</th><th>Your answer</th><th>When asked</th></tr></thead>
            <tbody>{SENSITIVE.map(([k, label]) => {
              const entry = p.sensitive?.[k] || {};
              return <tr key={k}>
                <td style={{ whiteSpace: "nowrap" }}>{label}</td>
                <td style={{ minWidth: 180 }}><input className="input" aria-label={`${label} answer`} value={entry.value || ""} placeholder="Leave blank to skip" onChange={e => setIn("sensitive", k, { ...entry, value: e.target.value })} /></td>
                <td><Segmented label={`${label}: when asked`} value={entry.mode === "answer" ? "answer" : "ask"} onChange={m => setIn("sensitive", k, { ...entry, mode: m })}
                  options={[{ value: "ask", label: "Ask me" }, { value: "answer", label: "Answer" }]} /></td>
              </tr>;
            })}</tbody>
          </table></div>
        </Section>

        <Section id="stealth" title="Stealth rule" hint="What to say when a form asks about current ventures or other employment.">
          <Field label="Rule" multiline rows={3} value={p.stealth_rule || ""} onChange={v => set("stealth_rule", v)} placeholder="Say I'm a full-time student; don't name side projects." />
        </Section>

        <div className="savebar" hidden={!dirty} role="region" aria-label="Unsaved changes">
          <span className="savebar__dot" aria-hidden /><span className="spacer">Unsaved changes</span>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setP(JSON.parse(saved))}>Discard</button>
          <button className="btn btn--primary" disabled={busy}>{busy ? "Saving…" : "Save profile"}<kbd className="subtle" style={{ fontSize: 11, marginLeft: 4, color: "inherit", opacity: 0.7 }}>⌘S</kbd></button>
        </div>
      </form>
    </div>
  </div>;
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return <section className="section" id={id} aria-labelledby={`${id}-title`}>
    <div className="section__head"><div><h2 id={`${id}-title`}>{title}</h2>{hint && <p>{hint}</p>}</div></div>
    {children}
  </section>;
}

function Field({ label, value, onChange, placeholder, hint, optional, multiline, rows = 3, code }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; optional?: boolean; multiline?: boolean; rows?: number; code?: boolean;
}) {
  const id = useId();
  return <div className="field">
    <label className="field__label" htmlFor={id}>{label}{optional && <span className="subtle" style={{ fontWeight: 400 }}> · optional</span>}</label>
    {multiline
      ? <textarea id={id} className={`textarea${code ? " textarea--code" : ""}`} rows={rows} spellCheck={!code} placeholder={placeholder} value={value || ""} onChange={e => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
      : <input id={id} className="input" placeholder={placeholder} value={value || ""} onChange={e => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />}
    {hint && <span id={`${id}-hint`} className="field__hint">{hint}</span>}
  </div>;
}
