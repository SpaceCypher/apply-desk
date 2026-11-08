import Link from "next/link";
import { notFound } from "next/navigation";
import { pool } from "@/lib/db";
import Gate from "../../gate";
import Refresh from "../../refresh";
import { ChevronLeft, ExternalLink, FileText, TriangleAlert } from "../../ui/icons";
import { MODE_LABEL, PLATFORM_LABEL, STATUS, Status, hostOf } from "../../ui/status";
import { Time } from "../../ui/time";
import HeaderActions from "./actions";

import JobView, { type Step } from "./job-view";

const ACTIVE = ["queued", "running", "needs_user", "awaiting_approval"];

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  return <Gate fallback={<div className="page"><div className="skeleton" style={{ width: 280, height: 24 }} /></div>}><Detail params={params} /></Gate>;
}

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  // "stalled": queued for 2 minutes without a worker claiming it, so it most likely missed its start. Only then is Run now offered.
  const job = (await pool.query("SELECT *, (status = 'queued' AND updated_at < now() - interval '2 minutes') AS stalled FROM jobs WHERE id=$1", [id])).rows[0];
  if (!job) notFound();
  const [steps, questions, documents, audit] = await Promise.all([
    pool.query("SELECT id, kind, detail, screenshot_key, created_at FROM job_steps WHERE job_id=$1 ORDER BY id", [id]),
    pool.query("SELECT id, kind, prompt, options, answer FROM questions WHERE job_id=$1 ORDER BY id", [id]),
    pool.query("SELECT id, kind, blob_key, created_at FROM documents WHERE job_id=$1 ORDER BY id", [id]),
    pool.query("SELECT action, detail, created_at FROM audit_log WHERE job_id=$1 ORDER BY id", [id]),
  ]);
  const open = questions.rows.find(q => q.answer === null);
  const host = hostOf(job.application_url);
  const tone = STATUS[job.status]?.tone;
  const stepList: Step[] = steps.rows.map(s => ({ id: Number(s.id), kind: s.kind, detail: s.detail || {}, shot: s.screenshot_key ? `/api/blob/${s.screenshot_key}` : null, at: new Date(s.created_at).toISOString() }));

  const side = <>
    <section className="card">
      <div className="card__head"><h2>Summary</h2></div>
      <div className="card__body">
        <dl className="dl">
          <dt>Status</dt><dd><Status status={job.status} /></dd>
          <dt>Mode</dt><dd>{MODE_LABEL[job.mode] || job.mode}</dd>
          <dt>Platform</dt><dd>{job.platform ? PLATFORM_LABEL[job.platform] || job.platform : "Not detected yet"}</dd>
          <dt>Added</dt><dd><Time value={job.created_at} /></dd>
          <dt>Updated</dt><dd><Time value={job.updated_at} /></dd>
          <dt>Submit</dt><dd>{job.submit_attempted_at ? <Time value={job.submit_attempted_at} /> : <span className="muted">Not attempted</span>}</dd>
          {job.cost?.model_calls > 0 && <><dt>Model calls</dt><dd className="num">{job.cost.model_calls}</dd>
            <dt>Tokens</dt><dd className="num">{Math.round((job.cost.tokens_in + job.cost.tokens_out) / 1000)}k</dd>
            <dt>Est. cost</dt><dd className="num">${Number(job.cost.cost).toFixed(3)}</dd></>}
        </dl>
      </div>
    </section>
    {job.receipt && <section className="card">
      <div className="card__head"><h2>Confirmation</h2></div>
      <div className="card__body stack-sm">
        {job.receipt.screenshot_key && <a href={`/api/blob/${job.receipt.screenshot_key}`} target="_blank" rel="noreferrer" className="thumb" style={{ width: "100%", marginTop: 0 }}>
          <img src={`/api/blob/${job.receipt.screenshot_key}`} alt="Confirmation page" /></a>}
        {job.receipt.snippet && <p className="muted" style={{ fontSize: "var(--text-sm)" }}>{job.receipt.snippet.slice(0, 220)}</p>}
      </div>
    </section>}
    <section className="card">
      <div className="card__head"><h2>Documents</h2></div>
      <div className="card__body">
        {documents.rows.length ? <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {documents.rows.map(d => <li key={d.id}><a className="link row" href={`/api/blob/${d.blob_key}`} target="_blank" rel="noreferrer">
            <FileText size={15} />{d.kind === "cover_letter" ? "Cover letter" : "Resume"}<span className="subtle">PDF</span></a></li>)}
        </ul> : <p className="muted" style={{ fontSize: "var(--text-sm)" }}>Made only when the form asks for one.</p>}
      </div>
    </section>
    {job.flags?.length > 0 && <section className="card">
      <div className="card__head"><TriangleAlert size={15} style={{ color: "var(--warning-text)" }} /><h2>Flags</h2></div>
      <div className="card__body"><ul className="stack-sm" style={{ margin: 0, paddingLeft: 18, fontSize: "var(--text-sm)" }}>
        {job.flags.map((f: string, i: number) => <li key={i}>{f}</li>)}
      </ul></div>
    </section>}
  </>;

  return <div className="page">
    <Refresh active={ACTIVE.includes(job.status)} />
    <Link href="/" className="btn btn--ghost btn--sm" style={{ marginLeft: -8, marginBottom: "var(--space-3)" }}><ChevronLeft size={14} />Jobs</Link>
    <header className="page-head" style={{ marginBottom: "var(--space-5)" }}>
      <div style={{ minWidth: 0 }}>
        <h1>{job.title || host}{job.company && <span className="muted" style={{ fontWeight: 400 }}> · {job.company}</span>}</h1>
        <div className="job-head__meta">
          <Status status={job.status} />
          <span className={`tag${job.mode === "auto" ? " tag--accent" : ""}`}>{MODE_LABEL[job.mode] || job.mode}</span>
          <a className="link row" style={{ gap: 4 }} href={job.application_url} target="_blank" rel="noreferrer noopener">{host}<ExternalLink size={12} /></a>
        </div>
      </div>
      <HeaderActions id={id} status={job.status} canRetry={!job.submit_attempted_at} stalled={job.stalled} />
    </header>
    {job.note && !open && <div className={`callout${tone === "danger" ? " callout--danger" : tone === "warning" ? " callout--warning" : ""}`} style={{ marginBottom: "var(--space-6)" }}>
      <TriangleAlert size={16} /><span>{job.note}</span>
    </div>}
    <JobView
      id={id}
      open={open ? { kind: open.kind, prompt: open.prompt, options: open.options || [] } : null}
      steps={stepList}
      description={job.job_description || ""}
      audit={audit.rows.map(a => ({ action: a.action, detail: a.detail, at: new Date(a.created_at).toISOString() }))}
      side={side}
    />
  </div>;
}
