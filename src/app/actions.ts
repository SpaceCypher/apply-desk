"use server";

import { signIn, signOut } from "@/auth";

// Module-level actions. Inline "use server" closures made Next encrypt bound values during prerender.
export async function signInWithGitHub() {
  await signIn("github");
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
