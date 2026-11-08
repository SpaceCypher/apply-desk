"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { X } from "./icons";

type Toast = { id: number; message: string; tone?: "danger"; action?: { label: string; onClick: () => void } };
type Push = (message: string, options?: { tone?: "danger"; action?: Toast["action"] }) => void;

const ToastContext = createContext<Push>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts(list => list.filter(t => t.id !== id)), []);
  const push = useCallback<Push>((message, options = {}) => {
    const id = ++next.current;
    setToasts(list => [...list.slice(-2), { id, message, ...options }]);
    setTimeout(() => dismiss(id), options.action ? 7000 : 4000);
  }, [dismiss]);
  return <ToastContext.Provider value={push}>
    {children}
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => <div key={t.id} className={`toast${t.tone ? ` toast--${t.tone}` : ""}`}>
        <span className="spacer">{t.message}</span>
        {t.action && <button className="btn btn--sm" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
        <button className="btn btn--ghost btn--icon btn--sm" style={{ color: "inherit" }} aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={14} /></button>
      </div>)}
    </div>
  </ToastContext.Provider>;
}
