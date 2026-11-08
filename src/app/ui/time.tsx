"use client";

import { useSyncExternalStore } from "react";

// False while the server renders and during hydration, true after: absolute times depend on the browser's timezone and locale.
const noop = () => () => {};
const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

// Relative time ("3m ago") with the exact time on hover.
export function relative(value: string | Date, now = Date.now()) {
  const t = new Date(value).getTime();
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d > 300 ? "numeric" : undefined });
}

export function Time({ value, className }: { value: string | Date; className?: string }) {
  const date = new Date(value);
  const mounted = useMounted();
  return <time className={className} dateTime={date.toISOString()} title={mounted ? date.toLocaleString() : undefined} suppressHydrationWarning>{relative(value)}</time>;
}

// An absolute time in the viewer's timezone. Empty on the server so hydration matches.
export function LocalTime({ value, className, timeOnly }: { value: string; className?: string; timeOnly?: boolean }) {
  const mounted = useMounted();
  const date = new Date(value);
  const text = timeOnly ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : date.toLocaleString();
  return <time className={className} dateTime={value}>{mounted ? text : ""}</time>;
}
