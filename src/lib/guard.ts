import { auth } from "@/auth";

// Returns a 401 Response when nobody is signed in, otherwise null.
export async function deny() {
  return (await auth()) ? null : Response.json({ error: "Sign in required." }, { status: 401 });
}
