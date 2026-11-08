"use client";

import { useEffect, useState } from "react";
import { Check, CircleAlert, Copy, Eye, KeyRound, RotateCcw, ShieldCheck, Trash2 } from "../ui/icons";
import { Empty, PageHeader, SkeletonRows } from "../ui/empty";
import { Time } from "../ui/time";
import { useToast } from "../ui/toast";

type Cred = { id: number; domain: string; created_at: string };
type Shown = { id: number; username: string; password: string };
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export default function Vault() {
  const toast = useToast();
  const [rows, setRows] = useState<Cred[] | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [left, setLeft] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/vault").then(r => (r.ok ? r.json() : Promise.reject())).then(d => { if (live) { setRows(d.credentials); setError(false); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [tick]);

  // Revealed credentials hide themselves after 30 seconds.
  useEffect(() => {
    if (!shown) return;
    const t = setInterval(() => setLeft(n => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, [shown]);
  useEffect(() => { if (confirmDelete === null) return; const t = setTimeout(() => setConfirmDelete(null), 4000); return () => clearTimeout(t); }, [confirmDelete]);

  async function reveal(id: number) {
    if (!pin) { setPinError("Enter your reveal PIN first."); return; }
    const r = await fetch("/api/vault", json("POST", { id, pin })).catch(() => null);
    const result = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setPinError(result.error || "Couldn't reveal. Try again."); return; }
    setPinError(null);
    setLeft(30); setShown({ id, username: result.username, password: result.password });
  }

  async function remove(id: number) {
    const r = await fetch("/api/vault", json("DELETE", { id })).catch(() => null);
    setConfirmDelete(null);
    if (!r?.ok) return toast("Couldn't delete. Try again.", { tone: "danger" });
    setRows(list => (list || []).filter(c => c.id !== id));
    toast("Login deleted. The agent will create a new account next time.");
  }

  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); } catch { toast("Couldn't copy.", { tone: "danger" }); }
  }

  return <div className="page">
    <PageHeader title="Vault" description="Logins the agent created on job sites, encrypted with AES-256-GCM. Revealing one needs your PIN and is written to the audit log." />

    {error && <div className="callout callout--danger" role="alert" style={{ marginBottom: "var(--space-4)" }}><CircleAlert size={16} />
      <span className="spacer">Couldn&apos;t load the vault.</span><button className="btn btn--secondary btn--sm" onClick={() => setTick(t => t + 1)}><RotateCcw size={12} />Retry</button></div>}

    {rows && rows.length > 0 && <div className="field" style={{ maxWidth: 320, marginBottom: "var(--space-4)" }}>
      <label className="field__label" htmlFor="pin">Reveal PIN</label>
      <input id="pin" className="input" type="password" autoComplete="off" value={pin} aria-invalid={!!pinError} aria-describedby="pin-help"
        onChange={e => { setPin(e.target.value); setPinError(null); }} />
      <span id="pin-help" className={pinError ? "field__error" : "field__hint"}>{pinError || "Set as VAULT_REVEAL_PIN in Vercel. Five wrong tries lock reveals for 10 minutes."}</span>
    </div>}

    {rows === null && !error ? <SkeletonRows rows={3} /> :
      rows && rows.length === 0 ? <div className="job-list"><Empty icon={<ShieldCheck size={18} />} title="No saved logins">
        When a site needs an account, the agent creates one with the job inbox, saves the password here before submitting the signup form, and reuses it next time.</Empty></div> :
      rows && <div className="table-wrap" style={{ overflowX: "auto" }}><table className="table">
        <thead><tr><th>Site</th><th>Login</th><th>Saved</th><th className="actions"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.map(c => {
          const open = shown?.id === c.id && left > 0 ? shown : null;
          return <tr key={c.id}>
            <td><span className="row" style={{ gap: 8 }}><KeyRound size={14} className="subtle" /><span className="mono">{c.domain}</span></span></td>
            <td>{open ? <div className="stack-sm" style={{ gap: 4 }}>
              <span className="row" style={{ gap: 6 }}><span className="mono">{open.username}</span>
                <button className="btn btn--ghost btn--icon btn--sm" aria-label="Copy username" onClick={() => copy(open.username, "Username")}><Copy size={13} /></button></span>
              <span className="row" style={{ gap: 6 }}><span className="mono">{open.password}</span>
                <button className="btn btn--ghost btn--icon btn--sm" aria-label="Copy password" onClick={() => copy(open.password, "Password")}><Copy size={13} /></button>
                <span className="subtle num" style={{ fontSize: "var(--text-xs)" }}>hides in {left}s</span></span>
            </div> : <span className="subtle" aria-label="Hidden">••••••••••</span>}</td>
            <td className="muted"><Time value={c.created_at} /></td>
            <td className="actions">
              {open ? <button className="btn btn--ghost btn--sm" onClick={() => setShown(null)}><Check size={13} />Hide</button>
                : <button className="btn btn--ghost btn--sm" onClick={() => reveal(c.id)}><Eye size={13} />Reveal</button>}
              <button className={`btn btn--sm ${confirmDelete === c.id ? "btn--danger" : "btn--ghost btn--icon"}`} aria-label={`Delete login for ${c.domain}`}
                onClick={() => (confirmDelete === c.id ? remove(c.id) : setConfirmDelete(c.id))}>{confirmDelete === c.id ? "Confirm delete" : <Trash2 size={14} />}</button>
            </td>
          </tr>;
        })}</tbody>
      </table></div>}
  </div>;
}
