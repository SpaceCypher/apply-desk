"use client";

import { useRef } from "react";

// Radio-group semantics with arrow-key movement.
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  function key(event: React.KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const i = options.findIndex(o => o.value === value);
    const n = options[(i + (event.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
    onChange(n.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
  }
  return <div ref={ref} className="segmented" role="radiogroup" aria-label={label} onKeyDown={key}>
    {options.map(o => <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>{o.label}</button>)}
  </div>;
}
