"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, MessageSquare, PenLine, Plus, RotateCcw, Search, Trash2, X } from "../ui/icons";
import { Empty, PageHeader, SkeletonRows } from "../ui/empty";
import { useToast } from "../ui/toast";

type Entry = { id: number; question: string; answer: string };
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export default function Bank() {
  const toast = useToast();
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const reload = () => setTick(t => t + 1);

  useEffect(() => {
    let live = true;
    fetch("/api/answers").then(r => (r.ok ? r.json() : Promise.reject())).then(d => { if (live) { setRows(d.answers); setError(false); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [tick]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows || []).filter(r => !q || `${r.question} ${r.answer}`.toLowerCase().includes(q));
  }, [rows, query]);

  async function upsert(question: string, answer: string) {
    const r = await fetch("/api/answers", json("POST", { question, answer })).catch(() => null);
    return !!r?.ok;
  }

  async function saveEdit(entry: Entry, question: string, answer: string) {
    if (!await upsert(question, answer)) return toast("Couldn't save. Try again.", { tone: "danger" });
    // A changed question is a new entry; drop the old one.
    if (question.trim().toLowerCase() !== entry.question.trim().toLowerCase()) await fetch("/api/answers", json("DELETE", { id: entry.id })).catch(() => null);
    setEditing(null); reload(); toast("Answer saved.");
  }

  async function remove(entry: Entry) {
    setRows(list => (list || []).filter(r => r.id !== entry.id));
    const r = await fetch("/api/answers", json("DELETE", { id: entry.id })).catch(() => null);
    if (!r?.ok) { reload(); return toast("Couldn't delete. Try again.", { tone: "danger" }); }
    toast("Answer deleted.", { action: { label: "Undo", onClick: async () => { await upsert(entry.question, entry.answer); reload(); } } });
  }

  return <div className="page">
    <PageHeader title="Answer bank" description="Every question the agent has met, with your approved answer. Answers you give on Telegram or a job page are saved here automatically."
      actions={<button className="btn btn--primary" onClick={() => { setAdding(true); setEditing(null); }}><Plus size={14} />Add answer</button>} />

    {rows && rows.length > 0 && <div className="row" style={{ marginBottom: "var(--space-4)" }}>
      <div style={{ position: "relative", flex: "1 1 280px", maxWidth: 420 }}>
        <Search size={14} style={{ position: "absolute", left: 10, top: 9, color: "var(--text-subtle)" }} />
        <input className="input" style={{ paddingLeft: 30 }} type="search" aria-label="Search answers" placeholder="Search questions and answers" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      <span className="muted num" style={{ fontSize: "var(--text-sm)" }}>{shown.length} of {rows.length}</span>
    </div>}

    {error && <div className="callout callout--danger" role="alert" style={{ marginBottom: "var(--space-4)" }}><CircleAlert size={16} />
      <span className="spacer">Couldn&apos;t load the answer bank.</span><button className="btn btn--secondary btn--sm" onClick={reload}><RotateCcw size={12} />Retry</button></div>}

    {adding && <div className="card" style={{ marginBottom: "var(--space-4)" }}>
      <EntryForm submitLabel="Add answer" onCancel={() => setAdding(false)} onSubmit={async (q, a) => {
        if (!await upsert(q, a)) return toast("Couldn't save. Try again.", { tone: "danger" });
        setAdding(false); reload(); toast("Answer added.");
      }} />
    </div>}

    {rows === null && !error ? <SkeletonRows rows={4} /> :
      rows && rows.length === 0 ? <div className="job-list"><Empty icon={<MessageSquare size={18} />} title="No answers yet"
        action={!adding && <button className="btn btn--secondary" onClick={() => setAdding(true)}><Plus size={14} />Add your first answer</button>}>
        Add answers to questions forms ask often — work authorization, notice period, “why this company” — so the agent stops asking.</Empty></div> :
      rows && shown.length === 0 ? <div className="job-list"><Empty title="No matches" action={<button className="btn btn--secondary btn--sm" onClick={() => setQuery("")}>Clear search</button>}>
        Nothing matches “{query}”.</Empty></div> :
      rows && <div className="table-wrap"><table className="table">
        <thead><tr><th style={{ width: "42%" }}>Question</th><th>Answer</th><th className="actions"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{shown.map(r => editing === r.id
          ? <tr key={r.id}><td colSpan={3} style={{ padding: 0 }}><EntryForm initial={r} submitLabel="Save" onCancel={() => setEditing(null)} onSubmit={(q, a) => saveEdit(r, q, a)} /></td></tr>
          : <tr key={r.id}>
            <td className="wrap">{r.question}</td>
            <td className="wrap muted">{r.answer}</td>
            <td className="actions">
              <button className="btn btn--ghost btn--icon btn--sm" aria-label={`Edit answer to ${r.question}`} onClick={() => { setEditing(r.id); setAdding(false); }}><PenLine size={14} /></button>
              <button className="btn btn--ghost btn--icon btn--sm" aria-label={`Delete answer to ${r.question}`} onClick={() => remove(r)}><Trash2 size={14} /></button>
            </td>
          </tr>)}</tbody>
      </table></div>}
  </div>;
}

function EntryForm({ initial, submitLabel, onSubmit, onCancel }: { initial?: Entry; submitLabel: string; onSubmit: (q: string, a: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState(initial?.question || "");
  const [a, setA] = useState(initial?.answer || "");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return <form className="card__body stack" onSubmit={e => { e.preventDefault(); if (q.trim() && a.trim()) onSubmit(q.trim(), a.trim()); }}
    onKeyDown={e => { if (e.key === "Escape") onCancel(); }}>
    <div className="field"><label className="field__label" htmlFor="q">Question</label>
      <input ref={first} id="q" className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Are you authorized to work in India?" /></div>
    <div className="field"><label className="field__label" htmlFor="a">Answer</label>
      <textarea id="a" className="textarea" rows={3} value={a} onChange={e => setA(e.target.value)} /></div>
    <div className="row" style={{ justifyContent: "flex-end" }}>
      <button type="button" className="btn btn--ghost" onClick={onCancel}><X size={14} />Cancel</button>
      <button className="btn btn--primary" disabled={!q.trim() || !a.trim()}><Check size={14} />{submitLabel}</button>
    </div>
  </form>;
}
