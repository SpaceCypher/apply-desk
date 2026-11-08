"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, CircleAlert, Lightbulb, Plus, RotateCcw, Trash2, X } from "../ui/icons";
import { Empty, PageHeader, SkeletonRows } from "../ui/empty";
import { Time } from "../ui/time";
import { useToast } from "../ui/toast";

type Lesson = { id: number; scope: string; text: string; status: "candidate" | "trusted" | "retired"; source: string; success_count: number; failure_count: number; evidence: { job_id?: string }[]; created_at: string; last_used: string | null };
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const TONE = { trusted: "tag--success", candidate: "tag--warning", retired: "" } as const;

export default function Lessons() {
  const toast = useToast();
  const [rows, setRows] = useState<Lesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState("platform:workday");
  const [text, setText] = useState("");
  const reload = () => setTick(t => t + 1);

  useEffect(() => {
    let live = true;
    fetch("/api/lessons").then(r => r.json()).then(d => { if (!live) return; if (d.lessons === null) setError(d.error); else { setRows(d.lessons); setError(null); } })
      .catch(() => { if (live) setError("Couldn't load lessons."); });
    return () => { live = false; };
  }, [tick]);

  async function setStatus(l: Lesson, status: Lesson["status"]) {
    const r = await fetch("/api/lessons", json("PATCH", { id: l.id, status })).catch(() => null);
    if (!r?.ok) return toast("Couldn't update the lesson.", { tone: "danger" });
    reload(); toast(status === "trusted" ? "Lesson trusted. The agent uses it from now on." : status === "retired" ? "Lesson retired." : "Moved back to candidates.");
  }
  async function remove(l: Lesson) {
    setRows(list => (list || []).filter(x => x.id !== l.id));
    const r = await fetch("/api/lessons", json("DELETE", { id: l.id })).catch(() => null);
    if (!r?.ok) { reload(); toast("Couldn't delete.", { tone: "danger" }); }
  }
  async function add(event: React.FormEvent) {
    event.preventDefault();
    const r = await fetch("/api/lessons", json("POST", { scope, text })).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) return toast(d.error || "Couldn't save.", { tone: "danger" });
    setText(""); setAdding(false); reload(); toast("Lesson added and trusted.");
  }

  const counts = { trusted: 0, candidate: 0, retired: 0 };
  for (const l of rows || []) counts[l.status]++;

  return <div className="page">
    <PageHeader title="Lessons" description="What the agent learned about operating specific sites. Candidates are tried in Review and Dry run; two good runs make a lesson trusted, two bad ones retire it. Lessons never contain your data and never tell the agent to submit."
      actions={<button className="btn btn--primary" onClick={() => setAdding(a => !a)}><Plus size={14} />Add lesson</button>} />

    {adding && <form className="card" style={{ marginBottom: "var(--space-4)" }} onSubmit={add}>
      <div className="card__body stack">
        <div className="grid-2">
          <div className="field"><label className="field__label" htmlFor="scope">Applies to</label>
            <input id="scope" className="input mono" value={scope} onChange={e => setScope(e.target.value)} />
            <span className="field__hint">platform:workday, platform:greenhouse, or domain:acme.wd5.myworkdayjobs.com</span></div>
          <div className="field"><label className="field__label" htmlFor="text">Lesson</label>
            <input id="text" className="input" value={text} maxLength={160} onChange={e => setText(e.target.value)} placeholder="Press Escape to close the password popup before Create Account" />
            <span className="field__hint">Starts with an action verb. Max 160 characters.</span></div>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--ghost" onClick={() => setAdding(false)}><X size={14} />Cancel</button>
          <button className="btn btn--primary" disabled={text.trim().length < 12}><Check size={14} />Save</button>
        </div>
      </div>
    </form>}

    {error && <div className="callout callout--danger" role="alert" style={{ marginBottom: "var(--space-4)" }}><CircleAlert size={16} />
      <span className="spacer">{error}</span><button className="btn btn--secondary btn--sm" onClick={reload}><RotateCcw size={12} />Retry</button></div>}

    {rows && rows.length > 0 && <p className="muted num" style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>{counts.trusted} trusted · {counts.candidate} candidates · {counts.retired} retired</p>}

    {rows === null && !error ? <SkeletonRows rows={4} /> :
      rows && rows.length === 0 ? <div className="job-list"><Empty icon={<Lightbulb size={18} />} title="No lessons yet">
        After runs that needed recovery, the agent writes short lessons about the site&apos;s mechanics. They show up here.</Empty></div> :
      rows && <div className="table-wrap" style={{ overflowX: "auto" }}><table className="table">
        <thead><tr><th>Lesson</th><th>Applies to</th><th>Status</th><th className="num">Good / bad runs</th><th>Last used</th><th className="actions"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.map(l => <tr key={l.id} style={l.status === "retired" ? { opacity: 0.6 } : undefined}>
          <td className="wrap" style={{ maxWidth: 420 }}>{l.text}
            {l.evidence?.[0]?.job_id && <> <Link className="link" style={{ fontSize: "var(--text-xs)" }} href={`/jobs/${l.evidence[0].job_id}`}>from job</Link></>}</td>
          <td><span className="mono" style={{ fontSize: "var(--text-xs)" }}>{l.scope}</span></td>
          <td><span className={`tag ${TONE[l.status]}`}>{l.status}</span> {l.source !== "reflection" && <span className="subtle" style={{ fontSize: "var(--text-xs)" }}>{l.source}</span>}</td>
          <td className="num">{l.success_count} / {l.failure_count}</td>
          <td className="muted">{l.last_used ? <Time value={l.last_used} /> : "Never"}</td>
          <td className="actions">
            {l.status !== "trusted" && <button className="btn btn--ghost btn--sm" onClick={() => setStatus(l, "trusted")}><Check size={13} />Trust</button>}
            {l.status !== "retired" && <button className="btn btn--ghost btn--sm" onClick={() => setStatus(l, "retired")}>Retire</button>}
            <button className="btn btn--ghost btn--icon btn--sm" aria-label={`Delete lesson: ${l.text}`} onClick={() => remove(l)}><Trash2 size={14} /></button>
          </td>
        </tr>)}</tbody>
      </table></div>}
  </div>;
}
