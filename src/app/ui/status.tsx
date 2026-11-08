export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "muted";

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  needs_user: { label: "Needs you", tone: "warning" },
  awaiting_approval: { label: "Awaiting approval", tone: "warning" },
  submission_unverified: { label: "Unverified submit", tone: "warning" },
  manual: { label: "Apply manually", tone: "warning" },
  applied: { label: "Applied", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  closed: { label: "Posting closed", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const MODE_LABEL: Record<string, string> = { dry_run: "Dry run", review: "Review", auto: "Auto" };
export const PLATFORM_LABEL: Record<string, string> = {
  greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday", google_forms: "Google Forms",
  typeform: "Typeform", smartrecruiters: "SmartRecruiters", custom: "Company site",
};

export function Status({ status }: { status: string }) {
  const s = STATUS[status] || { label: status.replace(/_/g, " "), tone: "neutral" as Tone };
  return <span className={`status status--${s.tone}`}><span className="status__dot" aria-hidden />{s.label}</span>;
}

export function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
