"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Play, RotateCcw, Trash2, X } from "../../ui/icons";
import { useToast } from "../../ui/toast";

export async function jobAction(id: string, body: Record<string, unknown>) {
  const r = await fetch(`/api/jobs/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const result = r ? await r.json().catch(() => ({})) : {};
  return { ok: !!r?.ok, error: result.error as string | undefined, dispatched: result.dispatched as boolean | undefined };
}

// Run now / Retry / Cancel, following the API's own rules about what is allowed. Cancel stays last so it never
// slides under the cursor when Retry turns into Run now.
export default function HeaderActions({ id, status, canRetry, stalled }: { id: string; status: string; canRetry: boolean; stalled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (!confirmCancel) return; const t = setTimeout(() => setConfirmCancel(false), 4000); return () => clearTimeout(t); }, [confirmCancel]);
  useEffect(() => { if (!confirmDelete) return; const t = setTimeout(() => setConfirmDelete(false), 4000); return () => clearTimeout(t); }, [confirmDelete]);

  async function remove() {
    setBusy(true);
    const r = await fetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => null);
    const result = r ? await r.json().catch(() => ({})) : {};
    setBusy(false); setConfirmDelete(false);
    if (!r?.ok) return toast(result.error || "Couldn't delete the job.", { tone: "danger" });
    toast("Job deleted.");
    router.push("/");
  }

  async function run(action: string, done: string) {
    setBusy(true);
    const r = await jobAction(id, { action });
    setBusy(false); setConfirmCancel(false);
    if (!r.ok) return toast(r.error || "That didn't work. Try again.", { tone: "danger" });
    toast(r.dispatched === false ? `${done} The worker didn't start; try Run now.` : done);
    router.refresh();
  }

  const canCancel = canRetry && ["queued", "running", "needs_user", "awaiting_approval"].includes(status);
  const canDelete = !["queued", "running", "needs_user", "awaiting_approval"].includes(status);
  return <div className="page-head__actions">
    {canRetry && ["failed", "needs_user", "manual", "cancelled"].includes(status) && <button className="btn btn--secondary" disabled={busy} onClick={() => run("retry", "Queued again.")}><RotateCcw size={14} />Retry</button>}
    {status === "queued" && stalled && <button className="btn btn--primary" disabled={busy} onClick={() => run("run", "Worker started.")}><Play size={14} />Run now</button>}
    {((status === "queued" && !stalled) || status === "running") && <span className="muted" role="status">{status === "running" ? "Running…" : "Starting…"}</span>}
    {canCancel && <button className={`btn ${confirmCancel ? "btn--danger" : "btn--ghost"}`} disabled={busy}
      onClick={() => confirmCancel ? run("cancel", "Job cancelled.") : setConfirmCancel(true)}><X size={14} />{confirmCancel ? "Confirm cancel" : "Cancel"}</button>}
    {canDelete && <button className={`btn ${confirmDelete ? "btn--danger" : "btn--danger-ghost"}`} disabled={busy}
      onClick={() => confirmDelete ? remove() : setConfirmDelete(true)}><Trash2 size={14} />{confirmDelete ? "Confirm delete" : "Delete"}</button>}
  </div>;
}
