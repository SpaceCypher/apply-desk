import { connection } from "next/server";
import { Suspense } from "react";
import { auth } from "@/auth";
import { signInWithGitHub } from "./actions";
import { BrandMark, GitHubMark } from "./ui/icons";

function SignIn() {
  return <div className="signin">
    <div className="brand-mark"><BrandMark size={22} /></div>
    <h1>Apply Desk</h1>
    <p>Paste a job link. The agent applies.</p>
    <form action={signInWithGitHub}>
      <button className="btn btn--primary btn--lg btn--block" type="submit"><GitHubMark />Continue with GitHub</button>
    </form>
    <p className="subtle" style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-4)" }}>Only the owner&apos;s GitHub account can sign in.</p>
  </div>;
}

async function Check({ children }: { children: React.ReactNode }) {
  await connection();
  return (await auth()) ? <>{children}</> : <SignIn />;
}

// Renders children only for the signed-in owner; otherwise the sign-in screen.
export default function Gate({ children, fallback }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  return <Suspense fallback={fallback ?? null}><Check>{children}</Check></Suspense>;
}
