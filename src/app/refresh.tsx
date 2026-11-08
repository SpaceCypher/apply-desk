"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-fetches the server component data while a job is active.
export default function Refresh({ active, every = 5000 }: { active: boolean; every?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), every);
    return () => clearInterval(t);
  }, [active, every, router]);
  return null;
}
