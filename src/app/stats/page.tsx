import { loadStats } from "../api/stats/route";
import Gate from "../gate";
import { Empty, PageHeader } from "../ui/empty";
import { BarChart3 } from "../ui/icons";
import { STATUS } from "../ui/status";
import { latestBench } from "@/lib/bench";
import { Time } from "../ui/time";

export default function StatsPage() {
  return <Gate><Charts /></Gate>;
}

const WEEKS = 12;

// The last 12 weeks (Monday starts, like Postgres date_trunc('week')), filling weeks with no applications.
function lastWeeks(rows: { week: string; applied: number }[]) {
  const today = new Date();
  const monday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - ((today.getUTCDay() + 6) % 7)));
  const byWeek = new Map(rows.map(r => [r.week, r.applied]));
  return Array.from({ length: WEEKS }, (_, i) => {
    const d = new Date(monday); d.setUTCDate(d.getUTCDate() - 7 * (WEEKS - 1 - i));
    const key = d.toISOString().slice(0, 10);
    return { key, label: d.toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" }), n: byWeek.get(key) || 0 };
  });
}

async function Charts() {
  const [{ weekly, byStatus, replies }, bench] = await Promise.all([loadStats(), latestBench()]);
  const total = byStatus.reduce((n: number, s: { n: number }) => n + s.n, 0);
  const applied = byStatus.filter((s: { status: string }) => ["applied", "submission_unverified"].includes(s.status)).reduce((n: number, s: { n: number }) => n + s.n, 0);
  const weeks = lastWeeks(weekly);
  const max = Math.max(1, ...weeks.map(w => w.n));
  const thisWeek = weeks[weeks.length - 1].n;

  const W = 720, H = 200, top = 20, bottom = 28, left = 28, gap = 10;
  const bw = (W - left - gap * (WEEKS - 1)) / WEEKS;
  const y = (n: number) => top + (H - top - bottom) * (1 - n / max);
  const ticks = [...new Set([0, Math.round(max / 2), max])];

  return <div className="page">
    <PageHeader title="Stats" description="How many applications went out, and how many got a human reply in the job inbox." />
    {total === 0 ? <div className="job-list"><Empty icon={<BarChart3 size={18} />} title="No data yet">Stats fill in as jobs run. Add a job on the Jobs page to start.</Empty></div> : <>
      <div className="kpis">
        <div className="kpi"><div className="kpi__label">Applications sent</div><div className="kpi__value">{applied}</div><div className="kpi__sub">{thisWeek} this week</div></div>
        <div className="kpi"><div className="kpi__label">Jobs with a reply</div><div className="kpi__value">{replies}</div><div className="kpi__sub">From the daily inbox scan</div></div>
        <div className="kpi"><div className="kpi__label">Reply rate</div><div className="kpi__value">{applied ? Math.round((replies / applied) * 100) : 0}%</div><div className="kpi__sub">Replies ÷ applications</div></div>
      </div>

      <section className="card" style={{ marginBottom: "var(--space-6)" }}>
        <div className="card__head"><h2>Applications per week</h2><span className="spacer" /><span className="muted" style={{ fontSize: "var(--text-xs)" }}>Last 12 weeks · week starting Monday</span></div>
        <div className="card__body">
          <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-labelledby="chart-title">
            <title id="chart-title">{`Applications per week for the last 12 weeks. Most in one week: ${max}.`}</title>
            {ticks.map(t => <g key={t}>
              <line className="grid" x1={left} x2={W} y1={y(t)} y2={y(t)} strokeDasharray={t ? "2 4" : undefined} />
              <text x={left - 8} y={y(t) + 4} textAnchor="end">{t}</text>
            </g>)}
            {weeks.map((w, i) => {
              const x = left + i * (bw + gap);
              return <g key={w.key}>
                <rect className={w.n ? "bar" : "bar bar--zero"} x={x} y={w.n ? y(w.n) : y(0) - 2} width={bw} height={w.n ? y(0) - y(w.n) : 2} rx={3}><title>{`${w.label}: ${w.n}`}</title></rect>
                {w.n > 0 && <text x={x + bw / 2} y={y(w.n) - 6} textAnchor="middle" style={{ fill: "var(--text)" }}>{w.n}</text>}
                {(i % 2 === 1 || i === WEEKS - 1) && <text x={x + bw / 2} y={H - 8} textAnchor="middle">{w.label}</text>}
              </g>;
            })}
          </svg>
        </div>
      </section>

      <section className="card">
        <div className="card__head"><h2>Every job by status</h2><span className="spacer" /><span className="muted num" style={{ fontSize: "var(--text-xs)" }}>{total} total</span></div>
        <div className="card__body">
          {byStatus.sort((a: { n: number }, b: { n: number }) => b.n - a.n).map((s: { status: string; n: number }) => {
            const meta = STATUS[s.status] || { label: s.status, tone: "neutral" };
            return <div className="hbar" key={s.status}>
              <span className="truncate">{meta.label}</span>
              <span className="hbar__track"><span className={`hbar__fill hbar__fill--${meta.tone}`} style={{ width: `${(s.n / total) * 100}%`, display: "block" }} /></span>
              <span className="num" style={{ textAlign: "right" }}>{s.n}</span>
            </div>;
          })}
        </div>
      </section>
    </>}

    <section className="card" style={{ marginTop: "var(--space-6)" }}>
      <div className="card__head"><h2>Bench</h2><span className="spacer" /><span className="muted" style={{ fontSize: "var(--text-xs)" }}>Dry runs on fixtures and live boards · latest per board</span></div>
      {!bench ? <div className="card__body muted" style={{ fontSize: "var(--text-sm)" }}>Run <code>npm run migrate</code> to add the bench table, then run the Bench workflow in GitHub Actions.</div>
        : !bench.length ? <div className="card__body muted" style={{ fontSize: "var(--text-sm)" }}>No bench runs yet. Run the Bench workflow in GitHub Actions to get a baseline.</div>
        : <div style={{ overflowX: "auto" }}><table className="table">
          <thead><tr><th>Board</th><th>Result</th><th>Reached</th><th className="num">Calls</th><th className="num">Asks</th><th className="num">Recoveries</th><th>When</th><th>Note</th></tr></thead>
          <tbody>{bench.map(b => <tr key={b.board}>
            <td><span className="mono">{b.board}</span> <span className="subtle" style={{ fontSize: "var(--text-xs)" }}>{b.kind}</span></td>
            <td>{b.passed ? <span className="tag tag--success">Pass</span> : <span className="tag tag--danger">Fail</span>}
              {b.prev_passed === true && !b.passed && <span className="tag tag--warning" style={{ marginLeft: 4 }}>Regression</span>}
              {b.prev_passed === false && b.passed && <span className="tag tag--accent" style={{ marginLeft: 4 }}>Fixed</span>}
              {b.safety_violations > 0 && <span className="tag tag--danger" style={{ marginLeft: 4 }}>Safety</span>}</td>
            <td className="muted">{b.stage.replace(/_/g, " ")}{b.expected_stage && b.expected_stage !== b.stage ? ` / ${b.expected_stage.replace(/_/g, " ")}` : ""}</td>
            <td className="num">{b.model_calls}</td><td className="num">{b.questions}</td><td className="num">{b.recoveries}</td>
            <td className="muted"><Time value={b.created_at} /></td>
            <td className="muted" style={{ maxWidth: 280, fontSize: "var(--text-xs)" }}>{b.failure_key && <a className="link" href={`/api/blob/${b.failure_key}`} target="_blank" rel="noreferrer">Screenshot</a>} {b.note}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </div>;
}
