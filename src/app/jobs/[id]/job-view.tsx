"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban, Camera, Check, ChevronLeft, ChevronRight, CircleCheck, CircleDot, ExternalLink, FileText, Mail, MessageSquare,
  MousePointerClick, PenLine, Send, ShieldCheck, TriangleAlert, Upload, X,
} from "../../ui/icons";
import { Empty } from "../../ui/empty";
import { useToast } from "../../ui/toast";
import { jobAction } from "./actions";
import { LocalTime } from "../../ui/time";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Step = { id: number; kind: string; detail: Record<string, any>; shot: string | null; at: string };
type Open = { kind: string; prompt: string; options: string[] } | null;
type Audit = { action: string; detail: unknown; at: string };
type TabId = "timeline" | "answers" | "description" | "audit";

const KIND: Record<string, { title: string; tone?: "success" | "warning" | "danger"; icon: typeof Check }> = {
  opened: { title: "Opened the posting", icon: ExternalLink },
  iframe_redirect: { title: "Opened the embedded application form", icon: ExternalLink },
  prefill: { title: "Filled fields from your profile", icon: PenLine },
  fill: { title: "Filled a field", icon: PenLine },
  check: { title: "Checked an option", icon: Check },
  click: { title: "Clicked", icon: MousePointerClick },
  upload: { title: "Uploaded a document", icon: Upload },
  ask_human: { title: "Asked you", icon: MessageSquare, tone: "warning" },
  workday: { title: "Workday step", icon: CircleDot },
  goto: { title: "Navigated", icon: ExternalLink },
  read_email: { title: "Checked the job inbox", icon: Mail },
  open_email_link: { title: "Opened the verification link", icon: Mail },
  verify_failed: { title: "A value didn't stick", icon: TriangleAlert, tone: "warning" },
  invalid: { title: "Rejected a planned action", icon: Ban, tone: "danger" },
  dry_run_stop: { title: "Stopped before submitting (dry run)", icon: ShieldCheck, tone: "success" },
  receipt: { title: "Submitted", icon: CircleCheck, tone: "success" },
  finish: { title: "Agent stopped", icon: CircleDot },
};

function describe(step: Step): string {
  const d = step.detail;
  switch (step.kind) {
    case "opened": return [d.company, d.title].filter(Boolean).join(" · ") || "Saved the job description";
    case "prefill": return (d.filled || []).map((f: any) => f.label).filter(Boolean).join(", ");
    case "fill": return d.label ? `${d.label} → ${d.value ?? ""}` : String(d.value ?? "");
    case "check": case "click": return d.label || "";
    case "upload": return d.doc === "cover_letter" ? "Cover letter" : "Resume";
    case "ask_human": return d.question || d.label || "";
    case "workday": return d.did || "";
    case "goto": return d.to || "";
    case "read_email": return d.found ? d.subject || "Found a message" : "No matching message yet";
    case "receipt": return d.confirmed ? "Confirmation page captured" : d.request_sent ? "Sent, but no confirmation appeared" : "Nothing was sent";
    case "verify_failed": return d.label ? `${d.label}: expected "${d.expected}"` : "";
    case "finish": return d.note || d.result || "";
    default: return d.reason || d.label || "";
  }
}


export default function JobView({ id, open, steps, description, audit, side }: {
  id: string; open: Open; steps: Step[]; description: string; audit: Audit[]; side: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabId>("timeline");
  const shots = steps.filter(s => s.shot);
  const [viewing, setViewing] = useState<number | null>(null);
  const answers = steps.flatMap(s => {
    const d = s.detail;
    if (s.kind === "prefill") return (d.filled || []).map((f: any) => ({ label: f.label, value: "From profile", source: f.source || "profile", confidence: "high" }));
    if (s.kind === "fill" || s.kind === "check") return [{ label: d.label, value: s.kind === "check" ? "Checked" : d.value, source: d.source, confidence: d.confidence }];
    if (s.kind === "upload") return [{ label: d.label || "File upload", value: d.doc === "cover_letter" ? "Cover letter PDF" : "Resume PDF", source: "document", confidence: "high" }];
    return [];
  });

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: "timeline", label: "Timeline", count: steps.length },
    { id: "answers", label: "Answers", count: answers.length },
    { id: "description", label: "Description" },
    { id: "audit", label: "Audit log", count: audit.length },
  ];

  return <>
    {open && <AskPanel id={id} open={open} latestShot={shots.at(-1) || null} onView={s => setViewing(shots.indexOf(s))} />}
    <div className="detail">
      <div style={{ minWidth: 0 }}>
        <div className="tabs" role="tablist" aria-label="Job details">
          {tabs.map(t => <button key={t.id} role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
            {t.label}{t.count !== undefined && <span className="tab__count">{t.count}</span>}
          </button>)}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "timeline" && (steps.length ? <ol className="timeline">
            {steps.map(s => {
              const k = KIND[s.kind] || { title: s.kind.replace(/_/g, " "), icon: CircleDot };
              const text = describe(s);
              return <li key={s.id}>
                <span className={`timeline__dot${k.tone ? ` timeline__dot--${k.tone}` : ""}`}><k.icon size={12} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="timeline__title">{k.title}</div>
                  {text && <div className="timeline__detail">{text}</div>}
                  {s.detail.reason && s.kind !== "invalid" && <div className="timeline__detail subtle">{s.detail.reason}</div>}
                  {s.shot && <button className="thumb" onClick={() => setViewing(shots.indexOf(s))} aria-label={`View screenshot: ${k.title}`}>
                    <img src={s.shot} alt="" loading="lazy" /></button>}
                </div>
                <LocalTime className="timeline__time" value={s.at} timeOnly />
              </li>;
            })}
          </ol> : <Empty icon={<Camera size={18} />} title="No steps yet">Each action the agent takes appears here with a screenshot.</Empty>)}

          {tab === "answers" && (answers.length ? <div className="table-wrap" style={{ overflowX: "auto" }}><table className="table">
            <thead><tr><th>Field</th><th>Value</th><th>Source</th></tr></thead>
            <tbody>{answers.map((a, i) => <tr key={i}>
              <td style={{ maxWidth: 280 }}>{a.label || <span className="subtle">Unlabelled</span>}</td>
              <td className="wrap" style={{ maxWidth: 320 }}>{String(a.value ?? "")}</td>
              <td><span className={`tag${a.confidence === "medium" ? " tag--warning" : a.source === "user" ? " tag--accent" : ""}`}>
                {a.confidence === "medium" ? "Inferred" : a.source === "answer_bank" ? "Answer bank" : a.source === "user" ? "You" : a.source === "document" ? "Document" : "Profile"}</span></td>
            </tr>)}</tbody>
          </table></div> : <Empty icon={<PenLine size={18} />} title="Nothing filled yet">Every value the agent enters is listed here with where it came from.</Empty>)}

          {tab === "description" && (description ? <pre className="prose-pre">{description}</pre> : <Empty icon={<FileText size={18} />} title="No description saved">It&apos;s saved when the agent first opens the posting.</Empty>)}

          {tab === "audit" && (audit.length ? <div className="table-wrap" style={{ overflowX: "auto" }}><table className="table">
            <thead><tr><th>Time</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>{audit.map((a, i) => <tr key={i}>
              <td className="num muted" style={{ whiteSpace: "nowrap" }}><LocalTime value={a.at} /></td>
              <td className="mono">{a.action}</td>
              <td className="mono wrap" style={{ fontSize: "var(--text-xs)", maxWidth: 420 }}>{typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail)}</td>
            </tr>)}</tbody>
          </table></div> : <Empty title="No audit entries">Submit attempts, account creation and the final result are recorded here.</Empty>)}
        </div>
      </div>
      <aside className="detail__side">{side}</aside>
    </div>
    {viewing !== null && viewing >= 0 && <Lightbox shots={shots} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />}
  </>;
}

function AskPanel({ id, open, latestShot, onView }: { id: string; open: NonNullable<Open>; latestShot: Step | null; onView: (s: Step) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const approval = open.kind === "approval";

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    const r = await jobAction(id, body);
    setBusy(false);
    if (!r.ok) return toast(r.error || "Couldn't send that. Try again.", { tone: "danger" });
    toast(done); setText(""); router.refresh();
  }

  const heading = approval ? "Ready to submit — review and approve" : open.kind === "captcha" ? "CAPTCHA — solve it in the remote browser" : "The agent needs an answer";
  return <section className="ask" aria-label="Needs you">
    <div className="ask__head"><TriangleAlert size={15} />{heading}</div>
    <div className="ask__body">
      <div className="stack">
        <p className="ask__prompt">{open.prompt}</p>
        {approval ? <div className="row">
          <button className="btn btn--primary" disabled={busy} onClick={() => send({ action: "approve" }, "Approved. Submitting now.")}><Check size={15} />Approve and submit</button>
          <button className={`btn ${confirmReject ? "btn--danger" : "btn--danger-ghost"}`} disabled={busy}
            onClick={() => confirmReject ? send({ action: "reject" }, "Rejected. Nothing was submitted.") : setConfirmReject(true)}>
            <X size={15} />{confirmReject ? "Confirm reject" : "Reject"}</button>
        </div> : <>
          {open.options.length > 0 && <div className="row">
            {open.options.map(o => <button key={o} className="btn btn--secondary" disabled={busy} onClick={() => send({ action: "answer", answer: o }, `Answered: ${o}`)}>{o}</button>)}
          </div>}
          {open.kind !== "captcha" && <form className="row" style={{ alignItems: "flex-start" }} onSubmit={e => { e.preventDefault(); if (text.trim()) send({ action: "answer", answer: text.trim() }, "Answer sent and saved to the answer bank."); }}>
            <label htmlFor="answer" className="sr-only">Your answer</label>
            <textarea id="answer" className="textarea" style={{ flex: "1 1 260px", minHeight: 40 }} rows={1} placeholder={open.options.length ? "Or type a different answer" : "Type your answer"}
              value={text} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); }} />
            <button className="btn btn--primary" disabled={busy || !text.trim()}><Send size={14} />Send</button>
          </form>}
          <p className="subtle" style={{ fontSize: "var(--text-xs)" }}>You can also answer from Telegram. Answers are saved to the answer bank for next time.</p>
        </>}
      </div>
      {latestShot && <button className="ask__thumb" onClick={() => onView(latestShot)} aria-label="View the latest screenshot">
        <img src={latestShot.shot!} alt="" /></button>}
    </div>
  </section>;
}

function Lightbox({ shots, index, onIndex, onClose }: { shots: Step[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<Element | null>(null);
  useEffect(() => {
    returnTo.current = document.activeElement;
    ref.current?.showModal();
    return () => (returnTo.current as HTMLElement | null)?.focus?.();
  }, []);
  const step = useCallback((delta: number) => onIndex(Math.min(shots.length - 1, Math.max(0, index + delta))), [index, onIndex, shots.length]);
  const s = shots[index];
  const k = KIND[s.kind];
  return <dialog ref={ref} className="lightbox" aria-label="Screenshot" onClose={onClose}
    onClick={e => { if (e.target === ref.current) ref.current?.close(); }}
    onKeyDown={e => { if (e.key === "ArrowRight") step(1); if (e.key === "ArrowLeft") step(-1); }}>
    <div className="lightbox__bar">
      <strong className="truncate">{k?.title || s.kind}</strong>
      <span className="subtle truncate">{describe(s)}</span>
      <span className="spacer" />
      <span className="num muted">{index + 1} / {shots.length}</span>
      <button className="btn btn--ghost btn--icon btn--sm" aria-label="Previous" disabled={index === 0} onClick={() => step(-1)}><ChevronLeft size={16} /></button>
      <button className="btn btn--ghost btn--icon btn--sm" aria-label="Next" disabled={index === shots.length - 1} onClick={() => step(1)}><ChevronRight size={16} /></button>
      <a className="btn btn--ghost btn--icon btn--sm" href={s.shot!} target="_blank" rel="noreferrer" aria-label="Open full size"><ExternalLink size={14} /></a>
      <button className="btn btn--ghost btn--icon btn--sm" aria-label="Close" onClick={() => ref.current?.close()}><X size={16} /></button>
    </div>
    <div className="lightbox__img"><img src={s.shot!} alt={k?.title || s.kind} /></div>
  </dialog>;
}
