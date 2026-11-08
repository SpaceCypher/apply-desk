"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleAlert, Inbox, Plus, RotateCcw, Trash2 } from "./ui/icons";
import { Empty, PageHeader, SkeletonRows } from "./ui/empty";
import { Segmented } from "./ui/segmented";
import { MODE_LABEL, PLATFORM_LABEL, Status, hostOf } from "./ui/status";
import { Time } from "./ui/time";
import { useToast } from "./ui/toast";

type Job = {
  id: string; application_url: string; status: string; mode: string; title: string | null; company: string | null;
  platform: string | null; note: string | null; created_at: string; updated_at: string;
};
type Mode = "review" | "dry_run" | "auto";

const TABS = [
  { id: "needs", label: "Needs you", statuses: ["needs_user", "awaiting_approval", "submission_unverified", "manual"] },
  { id: "active", label: "Active", statuses: ["queued", "running"] },
  { id: "applied", label: "Applied", statuses: ["applied"] },
  { id: "ended", label: "Ended", statuses: ["failed", "closed", "cancelled"] },
  { id: "all", label: "All", statuses: null },
] as const;
type TabId = (typeof TABS)[number]["id"];

const EMPTY_TAB: Record<TabId, [string, string]> = {
  needs: ["Nothing needs you", "Questions, approvals and jobs to finish by hand show up here."],
  active: ["Nothing running", "Queued and running jobs show up here."],
  applied: ["No applications yet", "Jobs move here once a confirmation page is captured."],
  ended: ["Nothing ended", "Failed, closed and cancelled jobs show up here."],
  all: ["No jobs", ""],
};

export default function Board() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => { if (!confirmClear) return; const t = setTimeout(() => setConfirmClear(false), 4000); return () => clearTimeout(t); }, [confirmClear]);
  const inactive = (jobs || []).filter(j => !["queued", "running", "needs_user", "awaiting_approval"].includes(j.status)).length;

  async function clearAll() {
    setConfirmClear(false);
    const r = await fetch("/api/jobs", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "all" }) }).catch(() => null);
    const result = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) return toast(result.error || "Couldn't delete jobs.", { tone: "danger" });
    toast(`Deleted ${result.deleted} job${result.deleted === 1 ? "" : "s"}. Active jobs were kept.`);
    setTick(n => n + 1);
  }

  useEffect(() => {
    let live = true;
    fetch("/api/jobs").then(async r => {
      if (!live) return;
      if (!r.ok) throw new Error();
      setJobs((await r.json()).jobs); setError(false);
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [tick]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") setTick(n => n + 1); }, 6000);
    return () => clearInterval(t);
  }, []);

  const counts = useMemo(() => Object.fromEntries(TABS.map(t => [t.id, (jobs || []).filter(j => !t.statuses || (t.statuses as readonly string[]).includes(j.status)).length])) as Record<TabId, number>, [jobs]);
  const requested = params.get("tab") as TabId | null;
  const tab: TabId = requested && TABS.some(t => t.id === requested) ? requested : counts.needs ? "needs" : "all";
  const statuses = TABS.find(t => t.id === tab)!.statuses as readonly string[] | null;
  const shown = (jobs || []).filter(j => !statuses || statuses.includes(j.status));

  function selectTab(id: TabId) {
    const next = new URLSearchParams(params);
    next.set("tab", id);
    router.replace(`${pathname}?${next}`, { scroll: false });
  }

  return <div className="page">
    <PageHeader title="Jobs" description="Paste a link. The agent fills the form, asks when it's unsure, and waits for your approval before submitting." />
    <Composer onAdded={(job, mode, dispatched) => {
      setTick(n => n + 1);
      selectTab("active");
      if (dispatched) toast(`Queued in ${MODE_LABEL[mode]} mode. The worker is starting.`);
      else toast("Queued, but the worker didn't start.", { action: { label: "Open job", onClick: () => router.push(`/jobs/${job}`) } });
    }} />

    {jobs && jobs.length > 0 && <div className="tabs" role="tablist" aria-label="Filter jobs">
      {TABS.map(t => <button key={t.id} role="tab" className="tab" aria-selected={t.id === tab} onClick={() => selectTab(t.id)}>
        {t.label}<span className="tab__count">{counts[t.id]}</span>
      </button>)}
      {inactive > 0 && <button className={`btn btn--sm ${confirmClear ? "btn--danger" : "btn--danger-ghost"}`} style={{ marginLeft: "auto" }}
        title="Deletes every job that is not active, with its steps and files" onClick={() => confirmClear ? clearAll() : setConfirmClear(true)}>
        <Trash2 size={12} />{confirmClear ? `Delete ${inactive} job${inactive === 1 ? "" : "s"}?` : "Delete all"}</button>}
    </div>}

    {error && <div className="callout callout--danger" style={{ marginBottom: "var(--space-4)" }} role="alert">
      <CircleAlert size={16} /><span className="spacer">Couldn&apos;t load jobs. {jobs ? "Showing the last list." : "Check the database connection."}</span>
      <button className="btn btn--secondary btn--sm" onClick={() => setTick(n => n + 1)}><RotateCcw size={12} />Retry</button>
    </div>}

    {jobs === null && !error ? <SkeletonRows /> :
      jobs && jobs.length === 0 ? <div className="job-list"><Empty icon={<Inbox size={18} />} title="No jobs yet">
        Paste a job link above. Start with Dry run: it fills the form and stops before anything is sent.
      </Empty></div> :
      jobs && shown.length === 0 ? <div className="job-list"><Empty title={EMPTY_TAB[tab][0]}>{EMPTY_TAB[tab][1]}</Empty></div> :
      jobs && <div className="job-list" role="list">{shown.map(j => <JobRow key={j.id} job={j} />)}</div>}
  </div>;
}

function JobRow({ job }: { job: Job }) {
  const host = hostOf(job.application_url);
  const needsAction = ["needs_user", "awaiting_approval"].includes(job.status);
  return <Link href={`/jobs/${job.id}`} className="job-row" role="listitem">
    <Status status={job.status} />
    <div style={{ minWidth: 0 }}>
      <div className="job-row__title truncate">{job.title || host}{job.company && <span className="muted" style={{ fontWeight: 400 }}> · {job.company}</span>}</div>
      <div className="job-row__sub truncate">{needsAction ? <span style={{ color: "var(--warning-text)", fontWeight: 500 }}>{job.status === "awaiting_approval" ? "Review and approve →" : "Answer a question →"} </span> : null}
        {job.note && !needsAction ? job.note : host}</div>
    </div>
    <span className="job-row__meta truncate">{job.platform ? PLATFORM_LABEL[job.platform] || job.platform : "—"}</span>
    <span><span className={`tag${job.mode === "auto" ? " tag--accent" : ""}`}>{MODE_LABEL[job.mode] || job.mode}</span></span>
    <Time value={job.updated_at} className="job-row__meta num" />
    <ChevronRight size={16} className="job-row__chev" />
  </Link>;
}

function Composer({ onAdded }: { onAdded: (id: string, mode: Mode, dispatched: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("review");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Start from the default mode in Settings.
  useEffect(() => {
    fetch("/api/settings").then(r => r.ok ? r.json() : null).then(d => {
      const m = d?.settings?.default_mode;
      if (m === "review" || m === "dry_run" || m === "auto") setMode(m);
    }).catch(() => {});
  }, []);

  // "/" focuses the link field from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function check(value: string) {
    try {
      const u = new URL(value.trim());
      return u.protocol === "https:" ? null : "Use the https:// link to the posting.";
    } catch { return "That doesn't look like a link. Paste the full URL, starting with https://"; }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const problem = check(url);
    if (problem) { setError(problem); input.current?.focus(); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim(), mode }) });
      const result = await r.json();
      if (!r.ok) { setError(result.error || "Couldn't add the job."); return; }
      setUrl(""); setError(null);
      onAdded(result.id, result.mode, result.dispatched);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  return <form className="composer" onSubmit={submit} noValidate>
    <div className="composer__input">
      <label htmlFor="job-url" className="sr-only">Job link</label>
      <input ref={input} id="job-url" className="input input--lg" type="url" inputMode="url" autoComplete="off" spellCheck={false}
        placeholder="Paste a job link — press / to focus" value={url} aria-invalid={!!error} aria-describedby={error ? "job-url-error" : undefined}
        onChange={e => { setUrl(e.target.value); if (error) setError(null); }} />
      {error && <span id="job-url-error" className="field__error">{error}</span>}
    </div>
    <Segmented label="Mode" value={mode} onChange={setMode} options={[
      { value: "review", label: "Review" }, { value: "dry_run", label: "Dry run" }, { value: "auto", label: "Auto" },
    ]} />
    <button className="btn btn--primary btn--lg" disabled={busy || !url.trim()}><Plus size={16} />{busy ? "Adding…" : "Add job"}</button>
  </form>;
}
