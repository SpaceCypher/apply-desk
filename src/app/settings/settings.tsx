"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Chips } from "../ui/chips";
import { CircleAlert, OctagonX, Play, RotateCcw } from "../ui/icons";
import { PageHeader } from "../ui/empty";
import { Segmented } from "../ui/segmented";
import { useToast } from "../ui/toast";

type Mode = "review" | "dry_run" | "auto";
type Form = { mode: Mode; domains: string[]; steps: string; minutes: string; tokens: string; budget: string };
const rangeError = (v: string, min: number, max: number) => { const n = Number(v); return !Number.isFinite(n) || n < min || n > max ? `Use a number from ${min.toLocaleString()} to ${max.toLocaleString()}.` : null; };
const DOMAIN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const MODE_HELP: Record<Mode, string> = {
  review: "Fills everything, then stops before Submit and sends you screenshots to approve.",
  dry_run: "Fills the form but never sends anything. Use this to test a new site.",
  auto: "Submits by itself. Only takes effect after 20 applied jobs; until then the worker uses Review.",
};

export default function Settings() {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState("");
  const [killed, setKilled] = useState(false);
  const [applied, setApplied] = useState(0);
  const [spent, setSpent] = useState(0);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/settings").then(r => (r.ok ? r.json() : Promise.reject())).then(({ settings, applied, spent }) => {
      if (!live) return;
      const f: Form = {
        mode: (settings.default_mode as Mode) || "review", domains: settings.allowed_domains || [], steps: String(settings.max_steps ?? 150),
        minutes: String(settings.max_minutes ?? 25), tokens: String(settings.max_tokens ?? 400000), budget: String(settings.monthly_budget_usd ?? 20),
      };
      setForm(f); setSaved(JSON.stringify(f)); setKilled(settings.kill_switch === true); setApplied(applied); setSpent(Number(spent) || 0); setError(false);
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [tick]);
  useEffect(() => { if (!confirmKill) return; const t = setTimeout(() => setConfirmKill(false), 4000); return () => clearTimeout(t); }, [confirmKill]);

  const steps = Number(form?.steps);
  const stepsError = form && (!Number.isInteger(steps) || steps < 10 || steps > 400) ? "Use a whole number from 10 to 400." : null;
  const minutesError = form && rangeError(form.minutes, 5, 120);
  const tokensError = form && rangeError(form.tokens, 20000, 5000000);
  const budgetError = form && rangeError(form.budget, 0, 1000);
  const budget = Number(form?.budget) || 0;
  const invalid = !!(stepsError || minutesError || tokensError || budgetError);
  const dirty = !!form && JSON.stringify(form) !== saved;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form || invalid) return;
    setBusy(true);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_mode: form.mode, allowed_domains: form.domains, max_steps: steps, max_minutes: Number(form.minutes), max_tokens: Number(form.tokens), monthly_budget_usd: Number(form.budget) }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) return toast((await r?.json().catch(() => null))?.error || "Couldn't save settings.", { tone: "danger" });
    setSaved(JSON.stringify(form)); toast("Settings saved.");
  }

  async function kill(on: boolean) {
    setBusy(true);
    const r = await fetch("/api/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) }).catch(() => null);
    setBusy(false); setConfirmKill(false);
    if (!r?.ok) return toast("Couldn't change the kill switch.", { tone: "danger" });
    setKilled(on); router.refresh();
    toast(on ? "Stopped. Unfinished jobs were cancelled." : "Runs are allowed again.");
  }

  const header = <PageHeader title="Settings" description="How the agent runs. Changes apply to the next job." />;
  if (error) return <div className="page page--narrow">{header}<div className="callout callout--danger" role="alert"><CircleAlert size={16} />
    <span className="spacer">Couldn&apos;t load settings.</span><button className="btn btn--secondary btn--sm" onClick={() => setTick(t => t + 1)}><RotateCcw size={12} />Retry</button></div></div>;
  if (!form) return <div className="page page--narrow">{header}<div className="stack">{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 88 }} />)}</div></div>;

  return <div className="page page--narrow">
    {header}
    <form onSubmit={save}>
      <section className="section">
        <div className="section__head"><div><h2>Default mode</h2><p>Used for links added without picking a mode, including links sent from Telegram.</p></div></div>
        <Segmented label="Default mode" value={form.mode} onChange={mode => setForm({ ...form, mode })}
          options={[{ value: "review", label: "Review" }, { value: "dry_run", label: "Dry run" }, { value: "auto", label: "Auto" }]} />
        <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-3)" }}>{MODE_HELP[form.mode]}</p>
        <div style={{ marginTop: "var(--space-4)", maxWidth: 360 }}>
          <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--text-xs)", marginBottom: 6 }}>
            <span className="muted">Auto mode unlock</span><span className="num">{Math.min(applied, 20)} / 20 applied</span></div>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={20} aria-valuenow={Math.min(applied, 20)} aria-label="Applied jobs toward auto mode"><span style={{ width: `${Math.min(100, (applied / 20) * 100)}%` }} /></div>
        </div>
      </section>

      <section className="section">
        <div className="section__head"><div><h2>Submission allowlist</h2><p>The agent only submits to the job&apos;s own domain and known ATS sites (Greenhouse, Lever, Ashby, Workday, Google Forms and others). Add any other domain a company uses.</p></div></div>
        <Chips label="Add domain" mono values={form.domains} onChange={domains => setForm({ ...form, domains })} placeholder="careers.example.com"
          validate={v => (DOMAIN.test(v) ? null : "Enter a domain like careers.example.com, without https://")} />
      </section>

      <section className="section">
        <div className="section__head"><div><h2>Limits per job</h2><p>The agent stops and reports a job that goes past any of these, so a confusing page can&apos;t loop or spend forever.</p></div></div>
        <div className="grid-3">
          <div className="field">
            <label className="field__label" htmlFor="steps">Max steps</label>
            <input id="steps" className="input num" type="number" inputMode="numeric" min={10} max={400} value={form.steps} aria-invalid={!!stepsError}
              onChange={e => setForm({ ...form, steps: e.target.value })} />
            {stepsError ? <span className="field__error">{stepsError}</span> : <span className="field__hint">Default 150</span>}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="minutes">Max minutes</label>
            <input id="minutes" className="input num" type="number" inputMode="numeric" min={5} max={120} value={form.minutes} aria-invalid={!!minutesError}
              onChange={e => setForm({ ...form, minutes: e.target.value })} />
            {minutesError ? <span className="field__error">{minutesError}</span> : <span className="field__hint">Default 25</span>}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="tokens">Max model tokens</label>
            <input id="tokens" className="input num" type="number" inputMode="numeric" min={20000} max={5000000} step={10000} value={form.tokens} aria-invalid={!!tokensError}
              onChange={e => setForm({ ...form, tokens: e.target.value })} />
            {tokensError ? <span className="field__error">{tokensError}</span> : <span className="field__hint">Default 400,000</span>}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head"><div><h2>Monthly budget</h2><p>Estimated Gemini spend, from each job&apos;s token counts. You get a Telegram alert at 80%; at 100% the worker stops picking up new jobs until next month. 0 means no cap.</p></div></div>
        <div className="row" style={{ alignItems: "flex-start", gap: "var(--space-6)" }}>
          <div className="field" style={{ maxWidth: 200 }}>
            <label className="field__label" htmlFor="budget">Budget (USD)</label>
            <input id="budget" className="input num" type="number" inputMode="decimal" min={0} max={1000} step={1} value={form.budget} aria-invalid={!!budgetError}
              onChange={e => setForm({ ...form, budget: e.target.value })} />
            {budgetError && <span className="field__error">{budgetError}</span>}
          </div>
          <div style={{ flex: "1 1 240px", maxWidth: 360, paddingTop: 26 }}>
            <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--text-xs)", marginBottom: 6 }}>
              <span className="muted">Spent this month</span><span className="num">${spent.toFixed(2)}{budget > 0 ? ` of $${budget}` : ""}</span></div>
            <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={budget || 1} aria-valuenow={spent} aria-label="Spend this month"><span style={{ width: `${budget > 0 ? Math.min(100, (spent / budget) * 100) : 0}%`, background: budget > 0 && spent >= budget * 0.8 ? "var(--warning)" : undefined }} /></div>
          </div>
        </div>
      </section>

      <div className="row" style={{ justifyContent: "flex-end", paddingBottom: "var(--space-6)" }}>
        {dirty && <button type="button" className="btn btn--ghost" onClick={() => setForm(JSON.parse(saved))}>Discard</button>}
        <button className="btn btn--primary" disabled={!dirty || invalid || busy}>{busy ? "Saving…" : "Save settings"}</button>
      </div>
    </form>

    <section className="section">
      <div className="section__head"><div><h2>Kill switch</h2><p>Stops everything: cancels unfinished jobs that haven&apos;t tried to submit, and blocks new runs until you resume. Same as /stop in Telegram.</p></div></div>
      <div className={`card${killed ? "" : ""}`} style={{ borderColor: killed ? "color-mix(in oklch, var(--danger) 40%, var(--border))" : undefined }}>
        <div className="card__body row">
          {killed ? <><OctagonX size={18} style={{ color: "var(--danger-text)" }} /><div className="spacer"><strong>All runs are stopped</strong><div className="muted" style={{ fontSize: "var(--text-sm)" }}>New jobs can&apos;t be added until you resume.</div></div>
            <button className="btn btn--primary" disabled={busy} onClick={() => kill(false)}><Play size={14} />Resume runs</button></>
            : <><span className="status status--success"><span className="status__dot" /></span><div className="spacer"><strong>The agent is allowed to run</strong><div className="muted" style={{ fontSize: "var(--text-sm)" }}>Jobs start as soon as they&apos;re added.</div></div>
              <button className={`btn ${confirmKill ? "btn--danger" : "btn--secondary"}`} disabled={busy} onClick={() => (confirmKill ? kill(true) : setConfirmKill(true))}>
                <OctagonX size={14} />{confirmKill ? "Confirm: stop everything" : "Stop everything"}</button></>}
        </div>
      </div>
    </section>
  </div>;
}
