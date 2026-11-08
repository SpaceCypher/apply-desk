"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOutAction } from "../actions";
import { BarChart3, BookOpen, BrandMark, FileText, KeyRound, LayoutList, Lightbulb, LogOut, Menu, MessageSquare, OctagonX, Play, Settings, User, X } from "../ui/icons";
import { useToast } from "../ui/toast";

const NAV = [
  { href: "/", label: "Jobs", icon: LayoutList },
  { href: "/profile", label: "Profile", icon: User },
  { href: "/answers", label: "Answer bank", icon: MessageSquare },
  { href: "/lessons", label: "Lessons", icon: Lightbulb },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/vault", label: "Vault", icon: KeyRound },
  { href: "/stats", label: "Stats", icon: BarChart3 },
];

export default function Sidebar({ needs, stopped, user }: { needs: number; stopped: boolean; user: { name: string; image: string | null } }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/jobs") : pathname.startsWith(href));

  // Close the mobile sheet on navigation and on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const link = (item: { href: string; label: string; icon: typeof User }, count?: number) =>
    <Link key={item.href} href={item.href} className="nav-link" aria-current={active(item.href) ? "page" : undefined} onClick={() => setOpen(false)}>
      <item.icon size={16} />{item.label}
      {!!count && <span className="nav-link__count num" aria-label={`${count} need you`}>{count}</span>}
    </Link>;

  return <>
    <div className="mobile-bar">
      <button className="btn btn--ghost btn--icon" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}><Menu size={18} /></button>
      <span className="brand-mark"><BrandMark /></span><strong>Apply Desk</strong>
    </div>
    {open && <div className="scrim" onClick={() => setOpen(false)} />}
    <aside className="sidebar" data-open={open} aria-label="Main">
      <div className="sidebar__brand">
        <span className="brand-mark"><BrandMark /></span>Apply Desk
        <button className="btn btn--ghost btn--icon btn--sm sidebar__close" style={{ marginLeft: "auto" }} aria-label="Close menu" onClick={() => setOpen(false)}><X size={16} /></button>
      </div>
      <nav className="sidebar__nav">
        {NAV.map((item, i) => link(item, i === 0 ? needs : undefined))}
        <div className="sidebar__section">Workspace</div>
        {link({ href: "/settings", label: "Settings", icon: Settings })}
        <a className="nav-link" href="https://github.com/SpaceCypher/job-agent#readme" target="_blank" rel="noreferrer"><BookOpen size={16} />Guide</a>
      </nav>
      <div className="sidebar__foot">
        <RunState stopped={stopped} />
        <div className="user-row">
          {user.image ? <img className="avatar" src={user.image} alt="" /> : <span className="avatar" />}
          <span className="truncate" style={{ fontSize: "var(--text-sm)", flex: 1 }}>{user.name}</span>
          <form action={signOutAction}><button className="btn btn--ghost btn--icon btn--sm" aria-label="Sign out" title="Sign out"><LogOut size={15} /></button></form>
        </div>
      </div>
    </aside>
  </>;
}

// Kill switch status. Stopping needs a second click; resuming is immediate.
function RunState({ stopped }: { stopped: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!confirming) return; const t = setTimeout(() => setConfirming(false), 4000); return () => clearTimeout(t); }, [confirming]);
  async function set(on: boolean) {
    setBusy(true);
    const r = await fetch("/api/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) }).catch(() => null);
    setBusy(false); setConfirming(false);
    if (!r?.ok) return toast("Couldn't change the kill switch. Try again.", { tone: "danger" });
    toast(on ? "Stopped. Unfinished jobs were cancelled." : "Runs are allowed again.");
    router.refresh();
  }
  if (stopped) return <div className="run-state run-state--stopped">
    <OctagonX size={14} /><span className="spacer">All runs stopped</span>
    <button className="btn btn--secondary btn--sm" disabled={busy} onClick={() => set(false)}><Play size={12} />Resume</button>
  </div>;
  return <div className="run-state">
    <span className="status status--success"><span className="status__dot" /></span><span className="spacer">Agent ready</span>
    <button className={`btn btn--sm ${confirming ? "btn--danger" : "btn--ghost"}`} disabled={busy} onClick={() => confirming ? set(true) : setConfirming(true)}>
      {confirming ? "Confirm stop" : "Stop all"}
    </button>
  </div>;
}
