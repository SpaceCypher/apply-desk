"use client";

import { useRef, useState } from "react";
import { X } from "./icons";

// Tag input: Enter or comma adds, Backspace on empty removes the last one.
export function Chips({ values, onChange, placeholder, label, validate, mono }: {
  values: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string; validate?: (v: string) => string | null; mono?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  function add(raw: string) {
    const v = raw.trim();
    if (!v) return;
    const problem = validate?.(v) ?? null;
    if (problem) return setError(problem);
    if (!values.some(x => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft(""); setError(null);
  }
  return <div className="stack-sm" style={{ gap: 4 }}>
    <div className="chips" onClick={() => input.current?.focus()}>
      {values.map(v => <span key={v} className={`chip${mono ? " mono" : ""}`}>{v}
        <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter(x => x !== v))}><X size={12} /></button></span>)}
      <input ref={input} aria-label={label} value={draft} placeholder={values.length ? "" : placeholder} aria-invalid={!!error}
        onChange={e => { setDraft(e.target.value); setError(null); }}
        onBlur={() => add(draft)}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); }
          else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
        }} />
    </div>
    {error && <span className="field__error">{error}</span>}
  </div>;
}
