import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { Suspense } from "react";
import { auth } from "@/auth";
import { pool } from "@/lib/db";
import "./globals.css";
import Sidebar from "./shell/sidebar";
import { ToastProvider } from "./ui/toast";

const sans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = { title: "Apply Desk", description: "Paste a job link. The agent applies." };

// Signed in: sidebar + content. Signed out: content only (pages render the sign-in screen).
async function Frame({ children }: { children: React.ReactNode }) {
  // Auth.js uses crypto randomness before reading cookies; mark this as request-time first.
  await connection();
  const session = await auth();
  if (!session) return <main className="main--bare">{children}</main>;
  const [needs, kill] = await Promise.all([
    pool.query("SELECT count(*)::int AS n FROM jobs WHERE status IN ('needs_user','awaiting_approval','submission_unverified','manual')").then(r => r.rows[0].n as number).catch(() => 0),
    pool.query("SELECT value FROM settings WHERE key='kill_switch'").then(r => r.rows[0]?.value === true).catch(() => false),
  ]);
  return <div className="app">
    <Sidebar needs={needs} stopped={kill} user={{ name: session.user?.name || "Signed in", image: session.user?.image || null }} />
    <main className="main">{children}</main>
  </div>;
}

function FrameFallback() {
  return <div className="app"><aside className="sidebar" aria-hidden /><main className="main" /></div>;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <ToastProvider>
          <Suspense fallback={<FrameFallback />}><Frame>{children}</Frame></Suspense>
        </ToastProvider>
      </body>
    </html>
  );
}
