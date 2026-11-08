"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "../ui/icons";
import { useToast } from "../ui/toast";

export type SetList<T> = (update: (current: T[]) => T[]) => void;

// Cards for a list of structured items: add, remove with undo, reorder.
export function ListEditor<T>({ items, setItems, title, render, create, addLabel, noun, max }: {
  items: T[]; setItems: SetList<T>; title: (item: T) => string; render: (item: T, update: (patch: Partial<T>) => void) => React.ReactNode;
  create: () => T; addLabel: string; noun: string; max: number;
}) {
  const toast = useToast();
  const move = (i: number, d: number) => setItems(list => {
    const next = [...list]; const j = i + d;
    if (j < 0 || j >= next.length) return list;
    [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  function remove(i: number) {
    const removed = items[i];
    setItems(list => list.filter((_, k) => k !== i));
    toast(`Removed ${noun}.`, { action: { label: "Undo", onClick: () => setItems(list => [...list.slice(0, i), removed, ...list.slice(i)]) } });
  }
  return <div>
    {items.map((item, i) => <div className="item" key={i}>
      <div className="item__head">
        <span className="item__title truncate spacer">{title(item) || <span className="subtle">New {noun}</span>}</span>
        <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Move ${noun} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
        <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Move ${noun} down`} disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
        <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${noun}`} onClick={() => remove(i)}><Trash2 size={14} /></button>
      </div>
      <div className="item__body">{render(item, patch => setItems(list => list.map((x, k) => (k === i ? { ...x, ...patch } : x))))}</div>
    </div>)}
    {items.length < max && <button type="button" className="btn btn--secondary add-btn" onClick={() => setItems(list => [...list, create()])}><Plus size={14} />{addLabel}</button>}
  </div>;
}

// A list of plain strings, each a textarea (experience bullets, writing samples).
export function TextList({ values, onChange, label, placeholder, rows = 2, max, addLabel }: {
  values: string[]; onChange: (v: string[]) => void; label: string; placeholder?: string; rows?: number; max: number; addLabel: string;
}) {
  return <div className="stack-sm">
    {values.map((v, i) => <div className="bullet" key={i}>
      <span className="bullet__mark" aria-hidden>{rows > 2 ? `${i + 1}.` : "•"}</span>
      <textarea className="textarea" aria-label={`${label} ${i + 1}`} rows={rows} style={{ minHeight: rows > 2 ? 120 : 40 }} placeholder={placeholder} value={v}
        onChange={e => onChange(values.map((x, k) => (k === i ? e.target.value : x)))} />
      <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(values.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
    </div>)}
    {values.length < max && <button type="button" className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => onChange([...values, ""])}><Plus size={13} />{addLabel}</button>}
  </div>;
}
