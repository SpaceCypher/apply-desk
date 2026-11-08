import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  callbacks: {
    signIn({ profile }) {
      return Boolean(process.env.ALLOWED_GITHUB_ID && String(profile?.id) === process.env.ALLOWED_GITHUB_ID);
    },
  },
});
