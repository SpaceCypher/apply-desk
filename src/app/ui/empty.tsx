export function Empty({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="empty">
    {icon && <div className="empty__icon" aria-hidden>{icon}</div>}
    <h3>{title}</h3>
    {children && <p>{children}</p>}
    {action}
  </div>;
}

export function PageHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return <header className="page-head">
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="page-head__actions">{actions}</div>}
  </header>;
}

export function SkeletonRows({ rows = 5, height = 52 }: { rows?: number; height?: number }) {
  return <div className="job-list" aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => <div key={i} style={{ height, padding: "0 16px", display: "flex", alignItems: "center", gap: 16, borderBottom: i < rows - 1 ? "1px solid var(--border)" : 0 }}>
      <div className="skeleton" style={{ width: 96, height: 12 }} />
      <div className="skeleton" style={{ width: `${40 + ((i * 17) % 35)}%`, height: 12 }} />
    </div>)}
  </div>;
}
