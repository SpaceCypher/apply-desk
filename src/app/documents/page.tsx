import Link from "next/link";
import { pool } from "@/lib/db";
import Gate from "../gate";
import { Empty, PageHeader } from "../ui/empty";
import { ExternalLink, FileText } from "../ui/icons";
import { Time } from "../ui/time";

export default function DocumentsPage() {
  return <Gate><List /></Gate>;
}

async function List() {
  const rows = (await pool.query("SELECT d.id, d.kind, d.blob_key, d.created_at, d.job_id, j.title, j.company, j.application_url FROM documents d LEFT JOIN jobs j ON j.id=d.job_id ORDER BY d.id DESC LIMIT 200")).rows;
  return <div className="page">
    <PageHeader title="Documents" description="Every resume and cover letter the agent generated, tailored per job from your profile." />
    {rows.length === 0 ? <div className="job-list"><Empty icon={<FileText size={18} />} title="No documents yet">
      A resume or cover letter is made only when a form asks for one. They appear here with the job they were made for.</Empty></div> :
      <div className="table-wrap" style={{ overflowX: "auto" }}><table className="table">
        <thead><tr><th>Document</th><th>For</th><th>Made</th><th className="actions"><span className="sr-only">Open</span></th></tr></thead>
        <tbody>{rows.map(d => <tr key={d.id}>
          <td><span className="row" style={{ gap: 8 }}><FileText size={15} className="subtle" />{d.kind === "cover_letter" ? "Cover letter" : "Resume"}</span></td>
          <td>{d.job_id ? <Link className="link" href={`/jobs/${d.job_id}`}>{d.title || (d.application_url ? new URL(d.application_url).hostname : "Job")}{d.company ? ` · ${d.company}` : ""}</Link> : <span className="subtle">—</span>}</td>
          <td className="muted"><Time value={d.created_at} /></td>
          <td className="actions"><a className="btn btn--ghost btn--sm" href={`/api/blob/${d.blob_key}`} target="_blank" rel="noreferrer">Open PDF<ExternalLink size={12} /></a></td>
        </tr>)}</tbody>
      </table></div>}
  </div>;
}
